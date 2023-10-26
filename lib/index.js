import EventEmitter from "events";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import DeepExtend from 'deep-extend';
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
            maxHttpBufferSize: 1073741824
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
        this.server = server;
        this.agent = ws;
        this.query = ws.handshake.query;
        this.log(this.server.LOGLEVEL.VERBOSE, 'Client connection open');
        this.init(callback);
    }
    async init(callback) {
        if (callback) {
            //perform callbacks first in order to allow the callback to handle permissions and set settings
            await callback({ auth: this.agent.handshake.auth, ...this.query }, (err, options) => {
                if (err) {
                    return this.close(err);
                }
                if (this.query) {
                    delete this.query.token;
                }
                if (options) {
                    //this room field is mandatory 
                    if (!options.room || options.room == '') {
                        this.close('Settings not setup correctly please follow interface');
                        return;
                    }
                    this.room = options.room;
                    this.log(this.server.LOGLEVEL.NORMAL, 'New Agent has joined room:' + this.room);
                    this.agent.join(this.room);
                }
                else {
                    this.log(this.server.LOGLEVEL.ERRORS, 'Settings not setup correctly please follow interface');
                    this.close('Settings not setup correctly please follow interface');
                    return;
                }
                ;
                this.agent.on('close', this.close.bind(this));
                this.agent.on('remote', this.send.bind(this));
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
        this.agent.leave(this.room);
        this.agent.disconnect();
        this.log(this.server.LOGLEVEL.VERBOSE, 'Agent connection closed');
    }
    error(error) {
        this.server.emit('error', this, error);
        this.close(error);
    }
    send(message) {
        this.log(this.server.LOGLEVEL.DEBUG, '>>>> ' + message + '###');
        this.server.io.to(this.room).emit('to_client', message, (error) => {
            if (error) {
                this.close(error);
            }
        });
    }
}
export class Client_Connection {
    constructor(server, ws, callback) {
        this.server = server;
        this.client = ws;
        this.query = ws.handshake.query;
        this.log(this.server.LOGLEVEL.VERBOSE, 'Client connection open');
        this.init(callback);
    }
    async init(callback) {
        if (callback) {
            //perform callbacks first in order to allow the callback to handle permissions and set settings
            await callback({ auth: this.client.handshake.auth, ...this.query }, (err, options) => {
                if (err) {
                    return this.close(err);
                }
                if (this.query) {
                    delete this.query.token;
                }
                if (options) {
                    this.guacOptions = options;
                    //this room field is mandatory 
                    if (!options.room || options.room == '') {
                        this.close('Settings not setup correctly please follow interface');
                        return;
                    }
                    this.room = options.room;
                    var agentSocket = this.get_agent_socket(options.room);
                    if (!agentSocket) {
                        this.close(new Error('Agent is not online or accepting connections right now.'));
                    }
                    else {
                        this.client.join(this.room);
                        this.log(this.server.LOGLEVEL.NORMAL, 'Client has joined agent in room:' + this.room);
                        //put unencrypted parameters from query into settings. Limit to allowed only
                        for (let param in this.query) {
                            if (this.guacOptions.settings &&
                                this.guacOptions.allowedUnencryptedConnectionSettings.findIndex(i => i == param) > -1) {
                                this.guacOptions.settings[param] = this.query[param];
                            }
                        }
                        this.client.emit('client_connected', this.guacOptions);
                    }
                }
                else {
                    this.log(this.server.LOGLEVEL.ERRORS, 'Settings not setup correctly please follow interface');
                    this.close('Settings not setup correctly please follow interface');
                    return;
                }
                ;
                this.client.on('close', this.close.bind(this));
                this.client.on('remote', this.send.bind(this));
            });
        }
        else {
            this.log(this.server.LOGLEVEL.ERRORS, 'Token validation failed');
            this.close('Callback is mandatory to decrypt token.');
            return;
        }
    }
    get_agent_socket(room) {
        const sockets = this.server.io.sockets.adapter.rooms.get(room);
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
        this.client.leave(this.room);
        this.client.disconnect();
        this.log(this.server.LOGLEVEL.VERBOSE, 'Client connection closed');
    }
    error(error) {
        this.server.emit('error', this, error);
        this.close(error);
    }
    send(message) {
        this.log(this.server.LOGLEVEL.DEBUG, '>>>> ' + message + '###');
        this.server.io.to(this.room).emit('to_agent', message, (error) => {
            if (error) {
                this.close(error);
            }
        });
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
            room: '',
            defaultSettings: {
                'port': '5900',
            },
            allowedUnencryptedConnectionSettings: vncUnencryptOptions
        };
        DeepExtend(this.clientOptions, clientOptions);
        this.clientOptions = clientOptions;
        this.state = this.STATE_OPENING;
        this.agent = agent;
        this.handshakeReplySent = false;
        this.receivedBuffer = '';
        this.lastActivity = Date.now();
        this.socket = this.agent.socket;
        this.socket.on('connect', this.processConnectionOpen.bind(this));
        this.socket.on('data', this.processReceivedData.bind(this));
    }
    close(error) {
        if (this.state == this.STATE_CLOSED) {
            return;
        }
        if (error) {
            this.log(this.LOGLEVEL.ERRORS, error);
        }
        this.log(this.LOGLEVEL.VERBOSE, 'Closing guacd connection');
        clearInterval(this.activityCheckInterval);
        this.state = this.STATE_CLOSED;
    }
    send(data) {
        if (this.state == this.STATE_CLOSED) {
            return;
        }
        this.log(this.LOGLEVEL.DEBUG, '<<<W2G< ' + data + '***');
        this.agent.send('to_client', data);
    }
    log(level, ...args) {
        if (level > this.agent.logOptions.level) {
            return;
        }
        const stdLogFunc = this.agent.logOptions.stdLog;
        const errorLogFunc = this.agent.logOptions.errorLog;
        let logFunc = stdLogFunc;
        if (level === this.LOGLEVEL.ERRORS) {
            logFunc = errorLogFunc;
        }
        var dt = new Date().toLocaleString('en-us', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        logFunc('[' + dt + ']', ...args);
    }
    processConnectionOpen() {
        this.log(this.LOGLEVEL.VERBOSE, 'guacd connection open');
        this.log(this.LOGLEVEL.VERBOSE, 'Selecting connection type: ' + this.clientOptions.type);
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
        //this.sendOpCode(['audio'].concat(this.clientConnection.query.GUAC_AUDIO || []));
        //this.sendOpCode(['video'].concat(this.clientConnection.query.GUAC_VIDEO || []));
        this.sendOpCode(['image']);
        let serverHandshake = this.getFirstOpCodeFromBuffer();
        this.log(this.LOGLEVEL.VERBOSE, 'Server sent handshake: ' + serverHandshake);
        serverHandshake = serverHandshake.split(',');
        let connectionOptions = [];
        for (let handshake of serverHandshake) {
            connectionOptions.push(this.getConnectionOption(handshake));
        }
        this.sendOpCode(connectionOptions);
        this.handshakeReplySent = true;
        if (this.state != this.STATE_OPEN) {
            this.state = this.STATE_OPEN;
            this.agent.send('open', this.agent);
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
        this.log(this.LOGLEVEL.VERBOSE, 'Sending opCode: ' + opCode);
        this.agent.send('to_client', opCode);
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
            this.agent.send('to_client', bufferPartToSend);
        }
    }
}
export class RemoteAgent {
    constructor(agent_opts, guacdOptions, log_opts) {
        this.LOGLEVEL = logLevel;
        this.logOptions = {
            level: this.LOGLEVEL.NORMAL,
            stdLog: console.log,
            errorLog: console.error
        };
        this.agent_options = agent_opts;
        this.guacdOptions = Object.assign({
            host: '127.0.0.1',
            port: 4822
        }, guacdOptions);
        if (log_opts) {
            this.logOptions = log_opts;
        }
        this.logOptions.stdLog('Agent Configured');
    }
    connect() {
        this.logOptions.stdLog('Agent Attempting Connection');
        this.socket = io(this.agent_options.host, this.agent_options.socket_opts);
        this.socket.on('connect', () => {
            this.logOptions.stdLog('Agent connected');
        });
        this.socket.on('client_connected', (options) => {
            this.guacd = new GuacamoleClient(this, this.logOptions, options);
        });
        this.socket.on('remote', (msg) => {
            this.logOptions.stdLog('Remote message');
        });
        this.socket.on('disconnect', () => {
            this.logOptions.stdLog('Socket disconnected');
        });
        this.socket.on('close', () => {
            this.logOptions.stdLog('Socket closed');
        });
        this.socket.on('error', (err) => {
            this.handle_socket_err(`error due to ${err.message}`);
        });
        this.socket.on('connect_error', (err) => {
            this.handle_socket_err(`connect_error due to ${err.message}`);
        });
        this.socket.on('connect_failed', (err) => {
            this.handle_socket_err(`connect_failed due to ${err.message}`);
        });
    }
    send(event, data) {
        this.socket.emit(event, data);
    }
    handle_socket_err(err) {
        this.logOptions.errorLog('Socket error', err);
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
