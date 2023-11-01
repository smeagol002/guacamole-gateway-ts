import EventEmitter from "events";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import DeepExtend from 'deep-extend';
import { connect } from "net";
export class SocketIOGatewayServer extends EventEmitter {
    constructor(server, log_options, callback) {
        super();
        this.LOGLEVEL = logLevel;
        this.logOptions = {
            level: this.LOGLEVEL.NORMAL,
            stdLog: console.log,
            errorLog: console.error
        };
        this.connectionsCount = 0;
        this.server = server;
        this.logOptions = log_options;
        this.connectionsCount = 0;
        if (this.logOptions.level >= this.LOGLEVEL.NORMAL) {
            this.logOptions.stdLog('Starting guacamole-lite socket.io server');
        }
        this.io = new Server(this.server, {
            'transports': ['websocket'],
            maxHttpBufferSize: 1073741824,
            pingTimeout: 60000
        });
        this.io.on('connection', async (socket) => {
            this.logOptions.stdLog('New Connection Attempt');
            if (socket.handshake.query.type && socket.handshake.query.type == 'client') {
                new Client_Connection(this, socket, callback);
            }
            else if (socket.handshake.query.type && socket.handshake.query.type == 'agent') {
                new Agent_Connection(this, socket, callback);
            }
            else {
            }
        });
        process.on('SIGTERM', this.close.bind(this));
        process.on('SIGINT', this.close.bind(this));
    }
    close() {
        if (this.logOptions.level >= this.LOGLEVEL.NORMAL) {
            this.logOptions.stdLog('Closing all connections and exiting...');
        }
        if (this.io) {
            this.io.close(() => { });
        }
    }
}
export class Agent_Connection {
    constructor(server, ws, callback) {
        ws['type'] = 'agent';
        this.server = server;
        this.agent = ws;
        this.query = ws.handshake.query;
        this.log(this.server.LOGLEVEL.VERBOSE, 'Client connection open');
        this.init(callback);
    }
    async init(callback) {
        if (callback) {
            //perform callbacks first in order to allow the callback to handle permissions and set settings
            await callback({ auth: this.agent.handshake.auth, ...this.query }, (err, room) => {
                if (err) {
                    return this.close(err);
                }
                if (this.query) {
                    delete this.query.token;
                }
                this.room = room;
                this.log(this.server.LOGLEVEL.NORMAL, 'New Agent has joined room:' + this.room);
                this.agent.join(String(this.room));
                this.agent.on('from_agent', (data) => {
                    this.log(this.server.LOGLEVEL.VERBOSE, 'from_agent -> to_client', data);
                    this.server.io.to(String(this.room)).emit('to_client', data, (error) => {
                        if (error) {
                            this.close(error);
                        }
                    });
                });
                this.agent.on('close', this.close.bind(this));
            });
        }
        else {
            this.log(this.server.LOGLEVEL.ERRORS, 'Token validation failed');
            this.close('Callback is mandatory to decrypt token.');
            return;
        }
    }
    log(level, ...args) {
        if (level > this.server.logOptions.level) {
            return;
        }
        const stdLogFunc = this.server.logOptions.stdLog;
        const errorLogFunc = this.server.logOptions.errorLog;
        let logFunc = stdLogFunc;
        if (level === this.server.LOGLEVEL.ERRORS) {
            logFunc = errorLogFunc;
        }
        logFunc(this.getLogPrefix(), ...args);
    }
    getLogPrefix() {
        var dt = new Date().toLocaleString('en-us', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return '[' + dt + '] [Connection to: ' + this.room + '] ';
    }
    close(error) {
        if (error) {
            this.log(this.server.LOGLEVEL.ERRORS, 'Closing agent connection with error: ', error);
        }
        this.agent.leave(String(this.room));
        this.agent.disconnect();
        this.log(this.server.LOGLEVEL.VERBOSE, 'Agent connection closed');
    }
    error(error) {
        this.server.emit('error', this, error);
        this.close(error);
    }
}
export class Client_Connection {
    constructor(server, ws, callback) {
        ws['type'] = 'client';
        this.server = server;
        this.client = ws;
        this.log(this.server.LOGLEVEL.VERBOSE, 'Client connection open');
        this.init(callback);
    }
    async init(callback) {
        if (callback) {
            //perform callbacks first in order to allow the callback to handle permissions and set settings
            await callback({ auth: this.client.handshake.auth, ...this.client.handshake.query }, (err, room) => {
                if (err) {
                    return this.close(err);
                }
                this.room = room;
                var agentSocket = this.get_agent_socket(this.room);
                if (!agentSocket) {
                    this.close(new Error('Agent is not online or accepting connections right now.'));
                }
                else {
                    this.client.join(String(this.room));
                    this.log(this.server.LOGLEVEL.NORMAL, 'Client has joined agent in room:' + this.room);
                    this.server.io.to(String(this.room)).emit('client_connected');
                }
                ;
                this.client.on('from_client', (data) => {
                    this.log(this.server.LOGLEVEL.VERBOSE, 'from_client -> to_agent relay', data);
                    this.server.io.to(String(this.room)).emit('to_agent', data, (error) => {
                        if (error) {
                            this.close(error);
                        }
                        ;
                    });
                });
                this.client.on('close', this.close.bind(this));
            });
        }
        else {
            this.log(this.server.LOGLEVEL.ERRORS, 'Token validation failed');
            this.close('Callback is mandatory to decrypt token.');
            return;
        }
    }
    get_agent_socket(room) {
        const sockets = this.server.io.sockets.adapter.rooms.get(String(room));
        if (sockets) {
            for (let socket of sockets) {
                const agentSocket = this.server.io.sockets.sockets.get(socket);
                if (agentSocket && agentSocket['type'] && agentSocket['type'] == 'agent') {
                    return agentSocket;
                }
            }
        }
        return;
    }
    log(level, ...args) {
        if (level > this.server.logOptions.level) {
            return;
        }
        const stdLogFunc = this.server.logOptions.stdLog;
        const errorLogFunc = this.server.logOptions.errorLog;
        let logFunc = stdLogFunc;
        if (level === this.server.LOGLEVEL.ERRORS) {
            logFunc = errorLogFunc;
        }
        logFunc(this.getLogPrefix(), ...args);
    }
    getLogPrefix() {
        var dt = new Date().toLocaleString('en-us', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return '[' + dt + '] [Connection to: ' + this.room + '] ';
    }
    close(error) {
        if (error) {
            this.log(this.server.LOGLEVEL.ERRORS, 'Closing connection with error: ', error);
        }
        ;
        this.client.leave(String(this.room));
        this.client.disconnect();
        this.log(this.server.LOGLEVEL.VERBOSE, 'Client connection closed');
    }
    error(error) {
        this.server.emit('error', this, error);
        this.close(error);
    }
}
export class GuacamoleClient {
    constructor(agent, logOptions, clientOptions) {
        this.LOGLEVEL = logLevel;
        this.STATE_OPENING = 0;
        this.STATE_OPEN = 1;
        this.STATE_CLOSED = 2;
        this.state = this.STATE_OPENING;
        this.handshakeReplySent = false;
        this.receivedBuffer = '';
        this.lastActivity = Date.now();
        this.logOptions = {
            level: this.LOGLEVEL.NORMAL,
            stdLog: console.log,
            errorLog: console.error
        };
        this.STATE_OPENING = 0;
        this.STATE_OPEN = 1;
        this.STATE_CLOSED = 2;
        this.logOptions = logOptions;
        this.clientOptions = {
            type: 'vnc',
            defaultSettings: {
                'port': '5900',
            },
            allowedUnencryptedConnectionSettings: vncUnencryptOptions
        };
        DeepExtend(this.clientOptions, clientOptions);
        this.clientOptions = clientOptions;
        console.log(this.clientOptions);
        this.state = this.STATE_OPENING;
        this.agent = agent;
        this.handshakeReplySent = false;
        this.receivedBuffer = '';
        this.lastActivity = Date.now();
        this.guacdConnection = connect(this.agent.guacdOptions.port, this.agent.guacdOptions.host);
        this.guacdConnection.on('connect', this.processConnectionOpen.bind(this));
        this.guacdConnection.on('data', this.processReceivedData.bind(this));
        this.guacdConnection.on('error', (error) => { this.agent.log(logLevel.ERRORS, error); });
        this.activityCheckInterval = setInterval(this.checkActivity.bind(this), 1000);
    }
    checkActivity() {
        this.agent.log(this.LOGLEVEL.DEBUG, Date.now(), " - ", (this.lastActivity + 10000), Date.now() > (this.lastActivity + 10000));
        if (Date.now() > (this.lastActivity + 20000)) {
            this.close(new Error('guacd was inactive for too long'));
        }
    }
    close(error) {
        if (this.state == this.STATE_CLOSED) {
            return;
        }
        if (error) {
            this.agent.log(this.LOGLEVEL.ERRORS, error);
        }
        this.agent.log(this.LOGLEVEL.VERBOSE, 'Closing guacd connection');
        clearInterval(this.activityCheckInterval);
        this.guacdConnection.removeAllListeners('close');
        this.guacdConnection.end();
        this.guacdConnection.destroy();
        this.state = this.STATE_CLOSED;
    }
    send(data) {
        if (this.state == this.STATE_CLOSED) {
            return;
        }
        this.agent.log(this.LOGLEVEL.DEBUG, '>>>> TO GUACAMOLE >>> ' + data + '>>>');
        this.guacdConnection.write(data);
    }
    processConnectionOpen() {
        this.agent.log(this.LOGLEVEL.VERBOSE, 'guacd connection open');
        this.agent.log(this.LOGLEVEL.VERBOSE, 'Selecting connection options: ' + this.clientOptions);
        this.sendOpCode(['select', this.clientOptions.type]);
    }
    sendHandshakeReply() {
        if (this.clientOptions.type == 'rdp' &&
            this.clientOptions.settings?.width &&
            this.clientOptions.settings.height &&
            this.clientOptions.settings.dpi) {
            this.sendOpCode([
                'size',
                this.clientOptions.settings.width,
                this.clientOptions.settings.height,
                this.clientOptions.settings.dpi
            ]);
        }
        this.sendOpCode(['audio'].concat([]));
        this.sendOpCode(['video'].concat([]));
        this.sendOpCode(['image']);
        let serverHandshake = this.getFirstOpCodeFromBuffer();
        this.agent.log(this.LOGLEVEL.VERBOSE, 'Server sent handshake: ' + serverHandshake);
        serverHandshake = serverHandshake.split(',');
        let connectionOptions = [];
        for (let handshake of serverHandshake) {
            connectionOptions.push(this.getConnectionOption(handshake));
        }
        this.sendOpCode(connectionOptions);
        this.handshakeReplySent = true;
        if (this.state != this.STATE_OPEN) {
            this.state = this.STATE_OPEN;
            this.agent.emit('open', this.agent);
        }
    }
    getConnectionOption(optionName) {
        if (this.clientOptions.settings && this.clientOptions.settings[this.parseOpCodeAttribute(optionName)]) {
            return this.clientOptions.settings[this.parseOpCodeAttribute(optionName)];
        }
        return null;
    }
    getFirstOpCodeFromBuffer() {
        let delimiterPos = this.receivedBuffer.indexOf(';');
        let opCode = this.receivedBuffer.substring(0, delimiterPos);
        this.receivedBuffer = this.receivedBuffer.substring(delimiterPos + 1, this.receivedBuffer.length);
        return opCode;
    }
    sendOpCode(opCode) {
        opCode = this.formatOpCode(opCode);
        this.agent.log(this.LOGLEVEL.VERBOSE, 'Sending opCode: ' + opCode);
        this.send(opCode);
    }
    formatOpCode(opCodeParts) {
        opCodeParts.forEach((part, index, opCodeParts) => {
            part = this.stringifyOpCodePart(part);
            opCodeParts[index] = part.length + '.' + part;
        });
        return opCodeParts.join(',') + ';';
    }
    stringifyOpCodePart(part) {
        if (part === null) {
            part = '';
        }
        return String(part);
    }
    parseOpCodeAttribute(opCodeAttribute) {
        return opCodeAttribute.substring(opCodeAttribute.indexOf('.') + 1, opCodeAttribute.length);
    }
    processReceivedData(data) {
        this.receivedBuffer += data;
        this.lastActivity = Date.now();
        if (!this.handshakeReplySent) {
            if (this.receivedBuffer.indexOf(';') === -1) {
                return; // incomplete handshake received from guacd. Will wait for the next part
            }
            else {
                this.sendHandshakeReply();
            }
        }
        this.sendBufferToWebSocket();
    }
    sendBufferToWebSocket() {
        const delimiterPos = this.receivedBuffer.lastIndexOf(';');
        const bufferPartToSend = this.receivedBuffer.substring(0, delimiterPos + 1);
        if (bufferPartToSend) {
            this.receivedBuffer = this.receivedBuffer.substring(delimiterPos + 1, this.receivedBuffer.length);
            this.agent.send('from_agent', bufferPartToSend);
        }
    }
}
export class RemoteAgent extends EventEmitter {
    constructor(agent_opts, guacdOptions, guacLiteOptions, log_opts) {
        super();
        this.LOGLEVEL = logLevel;
        this.logOptions = {
            level: this.LOGLEVEL.NORMAL,
            stdLog: console.log,
            errorLog: console.error
        };
        this.agent_options = agent_opts;
        this.guacLiteOptions = guacLiteOptions;
        this.guacdOptions = Object.assign({
            host: '127.0.0.1',
            port: 4822
        }, guacdOptions);
        if (log_opts) {
            this.logOptions = log_opts;
        }
        this.log('Agent Configured');
    }
    connect() {
        this.log('Agent Attempting Connection');
        this.socket = io(this.agent_options.host, this.agent_options.socket_opts);
        this.socket.on('connect', () => {
            this.log(logLevel.NORMAL, 'Agent connected to gateway');
        });
        this.socket.on('client_connected', async () => {
            if (this.agent_options.preConnect) {
                this.log(logLevel.DEBUG, 'client_connected will pre connect callback');
                await this.agent_options.preConnect(this.guacLiteOptions, (err, options) => {
                    if (err) {
                        return console.error('PreConnect Callback failed', err);
                    }
                    this.log(logLevel.DEBUG, 'client_connected pre connect complete, starting guacd connection', options);
                    this.guacd = new GuacamoleClient(this, this.logOptions, options);
                });
            }
            else {
                this.log(logLevel.DEBUG, 'client_connected will start guacd connection');
                this.guacd = new GuacamoleClient(this, this.logOptions, this.guacLiteOptions);
            }
        });
        //The gateway will emit anything 'from_client' to 'to_agent'
        this.socket.on('to_agent', (data) => {
            this.log(logLevel.VERBOSE, 'to_agent -> to guacamole client', data);
            this.guacd.send(data);
        });
        this.socket.on('disconnect', () => { this.log(logLevel.NORMAL, 'Socket disconnected'); });
        this.socket.on('close', () => { this.log(logLevel.NORMAL, 'Socket closed'); });
        this.socket.on('error', (err) => { this.handle_socket_err(`error due to ${err.message}`); });
        this.socket.on('connect_error', (err) => { this.handle_socket_err(`connect_error due to ${err.message}`); });
        this.socket.on('connect_failed', (err) => { this.handle_socket_err(`connect_failed due to ${err.message}`); });
    }
    log(level, ...args) {
        if (level > this.logOptions.level) {
            return;
        }
        const stdLogFunc = this.logOptions.stdLog;
        const errorLogFunc = this.logOptions.errorLog;
        let logFunc = stdLogFunc;
        if (level === this.LOGLEVEL.ERRORS) {
            logFunc = errorLogFunc;
        }
        var dt = new Date().toLocaleString('en-us', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        logFunc('[' + dt + ']', ...args);
    }
    send(event, data) {
        this.log(logLevel.VERBOSE, event + ' -> to gateway', data);
        this.socket.emit(event, data);
    }
    handle_socket_err(err) {
        this.log(logLevel.ERRORS, 'Socket error', err);
    }
}
/** TYPES */
export var logLevel;
(function (logLevel) {
    logLevel[logLevel["QUIET"] = 0] = "QUIET";
    logLevel[logLevel["ERRORS"] = 10] = "ERRORS";
    logLevel[logLevel["NORMAL"] = 20] = "NORMAL";
    logLevel[logLevel["VERBOSE"] = 30] = "VERBOSE";
    logLevel[logLevel["DEBUG"] = 40] = "DEBUG";
})(logLevel || (logLevel = {}));
export const commonUnencryptOptions = ['disable-copy', 'disable-paste', 'enable-sftp', 'sftp-disable-download', 'sftp-disable-upload', 'recording-name', 'recording-exclude-output', 'recording-exclude-mouse', 'recording-include-keys', 'typescript-name', 'backspace', 'terminal-type', 'color-scheme', 'font-name', 'font-size', 'scrollback', 'wol-send-packet'];
const vncPartUnencryptOptions = ['autoretry', 'color-depth', 'swap-red-blue', 'cursor', 'encodings', 'read-only', 'force-lossless', 'dest-host', 'reverse-connect', 'listen-timeout', 'enable-audio', 'audio-servername', 'clipboard-encoding'];
const rdpPartUnencryptOptions = ['normalize-clipboard', 'server-layout', 'timezone', 'color-depth', 'width', 'height', 'dpi', 'resize-method', 'force-lossless', 'disable-audio', 'enable-audio-input', 'enable-touch', 'enable-printing', 'enable-drive', 'disable-download', 'disable-upload', 'enable-wallpaper', 'enable-theming', 'enable-font-smoothing', 'enable-full-window-drag', 'enable-desktop-composition', 'enable-menu-animations', 'disable-bitmap-caching', 'disable-offscreen-caching', 'disable-glyph-caching'];
const sshPartUnencryptOptions = ['locale', 'timezone', 'enable-sftp', 'sftp-disable-download', 'sftp-disable-upload'];
const telnetPartUnencryptOptions = [];
const kubernetesPartUnencryptOptions = ['namespace'];
export const vncUnencryptOptions = [...vncPartUnencryptOptions, ...commonUnencryptOptions];
export const rdpUnencryptOptions = [...rdpPartUnencryptOptions, ...commonUnencryptOptions];
export const sshUnencryptOptions = [...sshPartUnencryptOptions, ...commonUnencryptOptions];
export const telnetUnencryptOptions = [...telnetPartUnencryptOptions, ...commonUnencryptOptions];
export const kubernetesUnencryptOptions = [...kubernetesPartUnencryptOptions, ...commonUnencryptOptions];
