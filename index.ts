import EventEmitter from "events";
import { Server as httpsServer} from 'https';
import { Server, Socket } from "socket.io";
import { io, Socket as clientSocket, ManagerOptions, SocketOptions } from "socket.io-client";
import DeepExtend from 'deep-extend';
import { connect, Socket as NetSocket } from "net";


export class SocketIOGatewayServer extends EventEmitter {

    LOGLEVEL = logLevel;
    server: httpsServer;
    logOptions: log_settings = {
        level: this.LOGLEVEL.NORMAL,
        stdLog: console.log,
        errorLog: console.error
    };
    connectionsCount: number = 0;
    io: Server;

    constructor(server: httpsServer, log_options: log_settings, callback?: preProcess) {
        super();

        this.server = server ;
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
        
        this.io.on('connection', async (socket: Socket) => {
            this.logOptions.stdLog('New Connection Attempt');
            
            if(socket.handshake.query.type && socket.handshake.query.type == 'client'){
                new Client_Connection(this, socket, callback);
            } else if(socket.handshake.query.type && socket.handshake.query.type == 'agent'){
                new Agent_Connection(this, socket, callback);
            } else {

            }
        });

        
        process.on('SIGTERM', this.close.bind(this));
        process.on('SIGINT', this.close.bind(this));

    }

    close() {
        if (this.logOptions.level >= this.LOGLEVEL.NORMAL) {
            this.logOptions.stdLog('Closing all connections and exiting...');
        }
        if(this.io){
            this.io.close(() => { });
        }
    }

}

export class Agent_Connection {

    server: SocketIOGatewayServer;
    room: string;
    agent: Socket;
    query: any;

    constructor(server: SocketIOGatewayServer, ws: Socket, callback?: preProcess) {     
        ws['type'] = 'agent';

        this.server = server;
        this.agent = ws;
        this.query = ws.handshake.query;

        this.log(this.server.LOGLEVEL.VERBOSE, 'Client connection open');
        this.init(callback);
    }

    async init(callback?: preProcess){

        if(callback){
            //perform callbacks first in order to allow the callback to handle permissions and set settings
           await callback({auth: this.agent.handshake.auth, ...this.query}, (err, room) => {
                if (err) { return this.close(err); }
                if(this.query){ delete this.query.token }
                
                this.room = room;
                this.log(this.server.LOGLEVEL.NORMAL, 'New Agent has joined room:' + this.room);
                this.agent.join(String(this.room));

                this.agent.on('from_agent', (data)=>{
                    this.log(this.server.LOGLEVEL.VERBOSE, 'from_agent -> to_client', data)
                    this.server.io.to(String(this.room)).emit('to_client', data, (error) => {
                        if (error) { this.close(error) }
                    })
                })

                this.agent.on('close', this.close.bind(this));
                
            });
        } else {
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
        var dt = new Date().toLocaleString('en-us', {year: 'numeric', month: '2-digit', day: '2-digit', hour:'2-digit', minute: '2-digit', second: '2-digit'});
        return '[' + dt + '] [Connection to: ' + this.room + '] ';
    }

    close(error) {
        if (error) { this.log(this.server.LOGLEVEL.ERRORS, 'Closing agent connection with error: ', error); }
        
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

    server: SocketIOGatewayServer;
    room: string;
    client: Socket;

    constructor(server: SocketIOGatewayServer, ws: Socket, callback?: preProcess) {
        ws['type'] = 'client';

        this.server = server;
        this.client = ws;

        this.log(this.server.LOGLEVEL.VERBOSE, 'Client connection open');
        this.init(callback);
    }

    async init(callback?: preProcess){

        if(callback){
            //perform callbacks first in order to allow the callback to handle permissions and set settings
           await callback({ auth: this.client.handshake.auth, ...this.client.handshake.query }, (err, room) => {
                if (err) { return this.close(err); }
                
                this.room = room;

                var agentSocket = this.get_agent_socket(this.room);
                if(!agentSocket){ 
                    this.close(new Error('Agent is not online or accepting connections right now.'));
                } else {
                    this.client.join(String(this.room));
                    this.log(this.server.LOGLEVEL.NORMAL, 'Client has joined agent in room:' + this.room);
                    this.server.io.to(String(this.room)).emit('client_connected');
                };

                
                this.client.on('from_client', (data)=>{
                    this.log(this.server.LOGLEVEL.VERBOSE, 'from_client -> to_agent relay', data);
                    this.server.io.to(String(this.room)).emit('to_agent', data, (error) => {
                        if (error) { this.close(error) };
                    });
                });

                this.client.on('close', this.close.bind(this));
            });
        } else {
            this.log(this.server.LOGLEVEL.ERRORS, 'Token validation failed');
            this.close('Callback is mandatory to decrypt token.');
            return;
        }  
    }

    get_agent_socket(room: string): Socket | undefined{
        const sockets = this.server.io.sockets.adapter.rooms.get(String(room));
        if(sockets){
            for (let socket of sockets) {
                const agentSocket = this.server.io.sockets.sockets.get(socket);
                if(agentSocket && agentSocket['type'] && agentSocket['type'] == 'agent'){
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
        var dt = new Date().toLocaleString('en-us', {year: 'numeric', month: '2-digit', day: '2-digit', hour:'2-digit', minute: '2-digit', second: '2-digit'});
        return '[' + dt + '] [Connection to: ' + this.room + '] ';
    }

    close(error) {
        if (error) {
            this.log(this.server.LOGLEVEL.ERRORS, 'Closing connection with error: ', error);
        };
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

    LOGLEVEL = logLevel;
    STATE_OPENING: number = 0;
    STATE_OPEN: number = 1;
    STATE_CLOSED: number = 2;

    state = this.STATE_OPENING;

    agent: RemoteAgent;
    handshakeReplySent: boolean = false;
    receivedBuffer: string = '';
    lastActivity: number = Date.now();
    logOptions: log_settings = {
        level: this.LOGLEVEL.NORMAL,
        stdLog: console.log,
        errorLog: console.error
    };
    clientOptions: guacLiteOptions;
    guacdConnection: NetSocket;
    activityCheckInterval: NodeJS.Timeout;

    constructor(agent: RemoteAgent, logOptions: log_settings, clientOptions: guacLiteOptions) {
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
        }
        DeepExtend(this.clientOptions, clientOptions);
        this.clientOptions = clientOptions;
        console.log(this.clientOptions)

        this.state = this.STATE_OPENING;

        this.agent = agent;
        this.handshakeReplySent = false;
        this.receivedBuffer = '';
        this.lastActivity = Date.now();

        this.guacdConnection = connect(this.agent.guacdOptions.port, this.agent.guacdOptions.host);

        this.guacdConnection.on('connect', this.processConnectionOpen.bind(this));
        this.guacdConnection.on('data', this.processReceivedData.bind(this));
        this.guacdConnection.on('error', (error)=>{ this.agent.log(logLevel.ERRORS, error) });

        this.activityCheckInterval = setInterval(this.checkActivity.bind(this), 1000);
    }

    checkActivity() {
        this.agent.log(this.LOGLEVEL.DEBUG, Date.now(), " - ", (this.lastActivity + 20000), Date.now() > (this.lastActivity + 20000));
        if (Date.now() > (this.lastActivity + 20000)) {
            this.close(new Error('guacd was inactive for too long'));
        }
    }

    close(error: any) {
        if (this.state == this.STATE_CLOSED) { return; }

        if (error) { this.agent.log(this.LOGLEVEL.ERRORS, error); }

        this.agent.log(this.LOGLEVEL.VERBOSE, 'Closing guacd connection');
        clearInterval(this.activityCheckInterval);

        this.guacdConnection.removeAllListeners('close');
        this.guacdConnection.end();
        this.guacdConnection.destroy();

        this.state = this.STATE_CLOSED;
    }

    send(data) {
        if (this.state == this.STATE_CLOSED) { return; }

        this.agent.log(this.LOGLEVEL.DEBUG, '>>>> TO GUACAMOLE >>> ' + data + '>>>');
        this.guacdConnection.write(data);
    }

    
    processConnectionOpen() {
        this.agent.log(this.LOGLEVEL.VERBOSE, 'guacd connection open');

        this.agent.log(this.LOGLEVEL.VERBOSE, 'Selecting connection type: ' + this.clientOptions.type);
        this.sendOpCode(['select', this.clientOptions.type]);
    }

    sendHandshakeReply() {
        if(this.clientOptions.type == 'rdp' && 
            this.clientOptions.settings?.width && 
            this.clientOptions.settings.height &&
            this.clientOptions.settings.dpi){
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

        let serverHandshake: string | string[] = this.getFirstOpCodeFromBuffer();

        this.agent.log(this.LOGLEVEL.VERBOSE, 'Server sent handshake: ' + serverHandshake);

        serverHandshake = serverHandshake.split(',');
        let connectionOptions: any[] = [];

        for(let handshake of serverHandshake){
            connectionOptions.push(this.getConnectionOption(handshake))
        }
        

        this.sendOpCode(connectionOptions);

        this.handshakeReplySent = true;

        if (this.state != this.STATE_OPEN) {
            this.state = this.STATE_OPEN;
            this.agent.emit('open', this.agent)
        }
    }

    getConnectionOption(optionName) {
        if(this.clientOptions.settings && this.clientOptions.settings[this.parseOpCodeAttribute(optionName)]){
            return this.clientOptions.settings[this.parseOpCodeAttribute(optionName)] 
        }
        return null
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
        if (part === null) { part = ''; }

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
            } else {
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

export class RemoteAgent extends EventEmitter{

    agent_options: agent_options;
    socket: clientSocket;
    LOGLEVEL = logLevel;
    logOptions: log_settings = {
        level: this.LOGLEVEL.NORMAL,
        stdLog: console.log,
        errorLog: console.error
    };
    guacdOptions: guacdOptions;
    guacLiteOptions: guacLiteOptions;
    guacd: GuacamoleClient;

    constructor(agent_opts: agent_options, guacdOptions: guacdOptions, guacLiteOptions: guacLiteOptions, log_opts?: log_settings){
        super();

        this.agent_options = agent_opts;
        this.guacLiteOptions = guacLiteOptions;
        this.guacdOptions = Object.assign({
            host: '127.0.0.1',
            port: 4822
        }, guacdOptions);

        if(log_opts){ this.logOptions = log_opts; }
        this.log('Agent Configured');
    }


    connect(){
        this.log('Agent Attempting Connection');
        this.socket = io(this.agent_options.host, this.agent_options.socket_opts);

        this.socket.on('connect', () => {
            this.log(logLevel.NORMAL,'Agent connected to gateway');
        });

        this.socket.on('client_connected', async () => {
            if(this.agent_options.preConnect){
                this.log(logLevel.DEBUG,'client_connected will pre connect callback');
                await this.agent_options.preConnect(this.guacLiteOptions, (err, options) => {
                    if (err) { return console.error('PreConnect Callback failed', err) }

                    this.log(logLevel.DEBUG,'client_connected pre connect complete, starting guacd connection', options);
                    this.guacd = new GuacamoleClient(this, this.logOptions, options);
                })
            } else {
                this.log(logLevel.DEBUG,'client_connected will start guacd connection');
                this.guacd = new GuacamoleClient(this, this.logOptions, this.guacLiteOptions);
            }
        });

        //The gateway will emit anything 'from_client' to 'to_agent'
        this.socket.on('to_agent', (data)=> {
            this.log(logLevel.VERBOSE, 'to_agent -> to guacamole client', data);
            this.guacd.send(data)
        })

        this.socket.on('disconnect',    () => {     this.log(logLevel.NORMAL, 'Socket disconnected'); });
        this.socket.on('close',         () => {     this.log(logLevel.NORMAL,'Socket closed'); });
        this.socket.on('error',         (err) => {  this.handle_socket_err(`error due to ${err.message}`); });
        this.socket.on('connect_error', (err) => {  this.handle_socket_err(`connect_error due to ${err.message}`); });
		this.socket.on('connect_failed',(err) => {  this.handle_socket_err(`connect_failed due to ${err.message}`); });
    }


    log(level, ...args) {
        if (level > this.logOptions.level) { return; }

        const stdLogFunc = this.logOptions.stdLog;
        const errorLogFunc = this.logOptions.errorLog;

        let logFunc = stdLogFunc;
        if (level === this.LOGLEVEL.ERRORS) { logFunc = errorLogFunc; }

        var dt = new Date().toLocaleString('en-us', {year: 'numeric', month: '2-digit', day: '2-digit', hour:'2-digit', minute: '2-digit', second: '2-digit'});

        logFunc('[' + dt + ']', ...args);
    }


    send(event: string,data: any) {
        this.log(logLevel.VERBOSE, event + ' -> to gateway', data);
        this.socket.emit(event, data);
    }


    handle_socket_err(err){
        this.log(logLevel.ERRORS, 'Socket error', err)
    }

}







/** TYPES */

export enum logLevel {
    QUIET= 0,
    ERRORS= 10,
    NORMAL= 20,
    VERBOSE= 30,
    DEBUG= 40,
  }

export interface preProcess {
    (options: {
        /**This should be your encrypted authentication information as a string. 
         * Include this in the auth field of the socket NOT as a query parameter. 
         * 
         * const socket = io("ws://example.com/my-namespace", {
            reconnectionDelayMax: 10000,
            auth: {
                token: "123" //This will be your encrypted token package
            },
            query: { //anything sent as a query will also be sent to the callback function
                "my-key": "my-value"
            }
            });
         * 
         * You will decrypt inside the callback function
         */
        auth: any, 
        /**Any other value that in NOT encrypted and included in the query of the socket will be sent to the callback for use as well*/
        [x: string]: any}, callback: (error: any, room: string) => void): Promise<void>;
    }

export type connection_type = "rdp"|"vnc"|"ssh"|"telnet"|"kubernetes";

export const commonUnencryptOptions: commonUnencryptOption[] = ['disable-copy','disable-paste','enable-sftp','sftp-disable-download','sftp-disable-upload','recording-name','recording-exclude-output','recording-exclude-mouse','recording-include-keys','typescript-name','backspace','terminal-type','color-scheme','font-name','font-size','scrollback','wol-send-packet']
const vncPartUnencryptOptions: vncUnencryptOption[] = ['autoretry','color-depth','swap-red-blue','cursor','encodings','read-only','force-lossless','dest-host','reverse-connect','listen-timeout','enable-audio','audio-servername','clipboard-encoding']
const rdpPartUnencryptOptions: rdpUnencryptOption[] = ['normalize-clipboard','server-layout','timezone','color-depth','width','height','dpi','resize-method','force-lossless','disable-audio','enable-audio-input','enable-touch','enable-printing','enable-drive','disable-download','disable-upload','enable-wallpaper','enable-theming','enable-font-smoothing','enable-full-window-drag','enable-desktop-composition','enable-menu-animations','disable-bitmap-caching','disable-offscreen-caching','disable-glyph-caching'];
const sshPartUnencryptOptions: sshUnencryptOption[] = ['locale','timezone','enable-sftp','sftp-disable-download','sftp-disable-upload'];
const telnetPartUnencryptOptions: telnetUnencryptOption[] = [];
const kubernetesPartUnencryptOptions: kubernetesUnencryptOption[] = ['namespace'];

export const vncUnencryptOptions: vncUnencryptOption[] = [...vncPartUnencryptOptions, ...commonUnencryptOptions]
export const rdpUnencryptOptions: rdpUnencryptOption[] = [...rdpPartUnencryptOptions, ...commonUnencryptOptions];
export const sshUnencryptOptions: sshUnencryptOption[] = [...sshPartUnencryptOptions, ...commonUnencryptOptions];
export const telnetUnencryptOptions: telnetUnencryptOption[] = [...telnetPartUnencryptOptions, ...commonUnencryptOptions];
export const kubernetesUnencryptOptions: kubernetesUnencryptOption[] = [...kubernetesPartUnencryptOptions, ...commonUnencryptOptions];

export type vncUnencryptOption = 'autoretry'|'color-depth'|'swap-red-blue'|'cursor'|'encodings'|'read-only'|'force-lossless'|'dest-host'|'reverse-connect'|'listen-timeout'|'enable-audio'|'audio-servername'|'clipboard-encoding'| & commonUnencryptOption;
export type rdpUnencryptOption = 'normalize-clipboard'|'server-layout'|'timezone'|'color-depth'|'width'|'height'|'dpi'|'resize-method'|'force-lossless'|'disable-audio'|'enable-audio-input'|'enable-touch'|'enable-printing'|'enable-drive'|'disable-download'|'disable-upload'|'enable-wallpaper'|'enable-theming'|'enable-font-smoothing'|'enable-full-window-drag'|'enable-desktop-composition'|'enable-menu-animations'|'disable-bitmap-caching'|'disable-offscreen-caching'|'disable-glyph-caching'|& commonUnencryptOption;
export type sshUnencryptOption = 'locale'|'timezone'|'enable-sftp'|'sftp-disable-download'|'sftp-disable-upload'| & commonUnencryptOption;
export type telnetUnencryptOption = '' | & commonUnencryptOption;
export type kubernetesUnencryptOption = 'namespace' | & commonUnencryptOption;

export type commonUnencryptOption = 'disable-copy'|'disable-paste'|'enable-sftp'|'sftp-disable-download'|'sftp-disable-upload'|'recording-name'|'recording-exclude-output'|'recording-exclude-mouse'|'recording-include-keys'|'typescript-name'|'backspace'|'terminal-type'|'color-scheme'|'font-name'|'font-size'|'scrollback'|'wol-send-packet';

export interface vnc_settings extends common_setting, vnc_unencrypted_settings {
    /**
     * The hostname or IP address of the VNC server Guacamole should connect to.
     */
    hostname: string;
    /**
     * The username to use when attempting authentication, if any. This parameter is optional.
     */
    username?: string;
    /**
     * The password to use when attempting authentication, if any. This parameter is optional.
     */
    password?: string;
    /**
     * The port the VNC server is listening on, usually 5900 or 5900 + display number. For example, if your VNC server is serving display number 1 (sometimes written as :1), your port number here would be 5901.
     */
    port: string;
    /**
     * The destination port to request when connecting to a VNC proxy such as UltraVNC Repeater. This is only necessary if the VNC proxy in use requires the connecting user to specify which VNC server to connect to. If the VNC proxy automatically connects to a specific server, this parameter is not necessary.
     */
    "dest-port"?: number | string;
}

export interface rdp_settings extends common_setting, rdp_unencrypted_settings  {
/**
 * The hostname or IP address of the RDP server Guacamole should connect to.
*/
hostname: string;
/**
 * The port the RDP server is listening on. This parameter is optional. If this is not specified, the standard port for RDP (3389) or Hyper-V’s default port for VMConnect (2179) will be used, depending on the security mode selected.
*/
port?: string;
/**
 * The username to use when attempting authentication, if any. This parameter is optional.
 */
username?: string;
/**
 * The password to use when attempting authentication, if any. This parameter is optional.
 */
password?: string;
/**
 * The domain to use when attempting authentication, if any. This parameter is optional.
 */
dommain?: string;
/**
 * The security mode to use for the RDP connection. This mode dictates how data will be encrypted and what type of authentication will be performed, if any. By default, a security mode is selected based on a negotiation process which determines what both the client and the server support.
 
    Possible values are:

    any
    Automatically select the security mode based on the security protocols supported by both the client and the server. This is the default.

    nla
    Network Level Authentication, sometimes also referred to as “hybrid” or CredSSP (the protocol that drives NLA). This mode uses TLS encryption and requires the username and password to be given in advance. Unlike RDP mode, the authentication step is performed before the remote desktop session actually starts, avoiding the need for the Windows server to allocate significant resources for users that may not be authorized.

    If the versions of guacd and Guacamole Client in use support prompting and the username, password, and domain are not specified, the user will be interactively prompted to enter credentials to complete NLA and continue the connection. Otherwise, when prompting is not supported and credentials are not provided, NLA connections will fail.

    nla-ext
    Extended Network Level Authentication. This mode is identical to NLA except that an additional “Early User Authorization Result” is required to be sent from the server to the client immediately after the NLA handshake is completed.

    tls
    RDP authentication and encryption implemented via TLS (Transport Layer Security). Also referred to as RDSTLS, the TLS security mode is primarily used in load balanced configurations where the initial RDP server may redirect the connection to a different RDP server.

    vmconnect
    Automatically select the security mode based on the security protocols supported by both the client and the server, limiting that negotiation to only the protocols known to be supported by Hyper-V / VMConnect.

    rdp
    Legacy RDP encryption. This mode is generally only used for older Windows servers or in cases where a standard Windows login screen is desired. Newer versions of Windows have this mode disabled by default and will only accept NLA unless explicitly configured otherwise.
    * 
    */
security?: "any" | "nla" | "nla-ext" | "tls" | "vmconnect" | "rdp";
/**
 *  If set to “true”, the certificate returned by the server will be ignored, even if that certificate cannot be validated. This is useful if you universally trust the server and your connection to the server, and you know that the server’s certificate cannot be validated (for example, if it is self-signed)
 */
"ignore-cert"?: boolean;
/**
 * If set to “true”, authentication will be disabled. Note that this refers to authentication that takes place while connecting. Any authentication enforced by the server over the remote desktop session (such as a login dialog) will still take place. By default, authentication is enabled and only used when requested by the server.
 
    If you are using NLA, authentication must be enabled by definition.
    * 
    */
"disable-auth"?: boolean;
/**
 * When connecting to the RDP server, Guacamole will normally provide its own hostname as the name of the client. If this parameter is specified, Guacamole will use its value instead.
 
    On Windows RDP servers, this value is exposed within the session as the CLIENTNAME environment variable.
    */
"client-name"?: string;
/**
 * If set to “true”, you will be connected to the console (admin) session of the RDP server.
 */
console?: boolean;

/**
* The name of the redirected printer device that is passed through to the RDP session. This is the name that the user will see in, for example, the Devices and Printers control panel.
* 
* If printer redirection is not enabled, this option has no effect.
*/
"printer-name"?: string;

/**
 * The name of the filesystem used when passed through to the RDP session. This is the name that users will see in their Computer/My Computer area along with client name (for example, “Guacamole on Guacamole RDP”), and is also the name of the share when accessing the special \\tsclient network location.
 *
 * If file transfer is not enabled, this parameter is ignored.
*/
"drive-name"?: string;
/**
 * The directory on the Guacamole server in which transferred files should be stored. This directory must be accessible by guacd and both readable and writable by the user that runs guacd. This parameter does not refer to a directory on the RDP server.
 * 
 * If file transfer is not enabled, this parameter is ignored.
*/
"drive-path"?: string;
/**
 * If set to “true”, and file transfer is enabled, the directory specified by the drive-path parameter will automatically be created if it does not yet exist. Only the final directory in the path will be created - if other directories earlier in the path do not exist, automatic creation will fail, and an error will be logged.
 * 
 * By default, the directory specified by the drive-path parameter will not automatically be created, and attempts to transfer files to a non-existent directory will be logged as errors.
 * 
 * If file transfer is not enabled, this parameter is ignored.
*/
"create-drive-path"?: boolean;
/**
 * If set to “true”, audio will be explicitly enabled in the console (admin) session of the RDP server. Setting this option to “true” only makes sense if the console parameter is also set to “true”.
*/
"console-audio"?: boolean;
/**
 * A comma-separated list of static channel names to open and expose as pipes. If you wish to communicate between an application running on the remote desktop and JavaScript, this is the best way to do it. Guacamole will open an outbound pipe with the name of the static channel. If JavaScript needs to communicate back in the other direction, it should respond by opening another pipe with the same name.
 * 
 * Guacamole allows any number of static channels to be opened, but protocol restrictions of RDP limit the size of each channel name to 7 characters.
*/
"static-channels"?: string;
/**
 * The numeric ID of the RDP source. This is a non-negative integer value dictating which of potentially several logical RDP connections should be used. This parameter is optional, and is only required if the RDP server is documented as requiring it. If using Hyper-V, this should be left blank.
 */
"preconnection-id"?: string;
/**
 * An arbitrary string which identifies the RDP source - one of potentially several logical RDP connections hosted by the same RDP server. This parameter is optional, and is only required if the RDP server is documented as requiring it, such as Hyper-V. In all cases, the meaning of this parameter is opaque to the RDP protocol itself and is dictated by the RDP server. For Hyper-V, this will be the ID of the destination virtual machine.
 */
"preconnection-blob"?: string;
/**
 * The hostname of the remote desktop gateway that should be used as an intermediary for the remote desktop connection. If omitted, a gateway will not be used.
*/
"gateway-hostname"?: string;

/**
* The port of the remote desktop gateway that should be used as an intermediary for the remote desktop connection. By default, this will be “443”.
*/
"gateway-port"?: number;

/**
* The username of the user authenticating with the remote desktop gateway, if a gateway is being used. This is not necessarily the same as the user actually using the remote desktop connection.
*/
"gateway-username"?: string;
/**
* The password to provide when authenticating with the remote desktop gateway, if a gateway is being used.
*/
"gateway-password"?: string;
/** 
* The domain of the user authenticating with the remote desktop gateway, if a gateway is being used. This is not necessarily the same domain as the user actually using the remote desktop connection.
*/
"gateway-domain"?: string;
/**
* The load balancing information or cookie which should be provided to the connection broker. If no connection broker is being used, this should be left blank.
*/
"load-balance-info"?: string;
/**
 * Specifies the RemoteApp to start on the remote desktop. If supported by your remote desktop server, this application, and only this application, will be visible to the user.
 * 
 * Windows requires a special notation for the names of remote applications. The names of remote applications must be prefixed with two vertical bars. For example, if you have created a remote application on your server for notepad.exe and have assigned it the name “notepad”, you would set this parameter to: “||notepad”.
*/
"remote-app"?: string;
/**
 * The working directory, if any, for the remote application. This parameter has no effect if RemoteApp is not in use.
*/
"remote-app-dir"?: string;
/**
 * The command-line arguments, if any, for the remote application. This parameter has no effect if RemoteApp is not in use.
*/
"remote-app-args"?: string;
}

export interface ssh_settings extends common_setting, ssh_unencrypted_settings {
/**
 * The hostname or IP address of the SSH server Guacamole should connect to.
 */
hostname: string;
/**
 * The port the SSH server is listening on, usually 22. This parameter is optional. If this is not specified, the default of 22 will be used.
 */
port?: number

/**
 * The known hosts entry for the SSH server. This parameter is optional, and, if not provided, no verification of host identity will be done. If the parameter is provided the identity of the server will be checked against the data.
 * 
 * The format of this parameter is that of a single entry from an OpenSSH known_hosts file.
 * 
 * For more information, please see SSH Host Verification.
*/
"host-key"?: string;
/**
 * By default the SSH client does not send keepalive requests to the server. This parameter allows you to configure the the interval in seconds at which the client connection sends keepalive packets to the server. The default is 0, which disables sending the packets. The minimum value is 2.
*/
"server-alive-interval"?: number;
/**
 * The username to use to authenticate, if any. This parameter is optional. If not specified, you will be prompted for the username upon connecting.
*/
username?: string;
/**
 * The password to use when attempting authentication, if any. This parameter is optional. If not specified, you will be prompted for your password upon connecting.
*/
password?: string;
/**
 * The entire contents of the private key to use for public key authentication. If this parameter is not specified, public key authentication will not be used. The private key must be in OpenSSH format, as would be generated by the OpenSSH ssh-keygen utility.
*/
"private-key"?: string;
/**
 * The passphrase to use to decrypt the private key for use in public key authentication. This parameter is not needed if the private key does not require a passphrase. If the private key requires a passphrase, but this parameter is not provided, the user will be prompted for the passphrase upon connecting.
*/
passphrase?: string;
/**
 * The command to execute over the SSH session, if any. This parameter is optional. If not specified, the SSH session will use the user’s default shell.
*/
command?: string;

/**
 * The directory to expose to connected users via Guacamole’s file browser. If omitted, the root directory will be used by default.
*/
"sftp-root-directory"?: string;

}

export interface telnet_settings extends common_setting, telnet_unencrypted_settings {
/**
 * The hostname or IP address of the telnet server Guacamole should connect to.
 */
hostname: string;
/**
 * The port the telnet server is listening on, usually 23. This parameter is optional. If this is not specified, the default of 23 will be used.
*/
port?: number;
/**
 * The username to use to authenticate, if any. This parameter is optional. If not specified, or not supported by the telnet server, the login process on the telnet server will prompt you for your credentials. For this to work, your telnet server must support the NEW-ENVIRON option, and the telnet login process must pay attention to the USER environment variable. Most telnet servers satisfy this criteria.
*/
username?: string;
/**
 * The password to use when attempting authentication, if any. This parameter is optional. If specified, your password will be typed on your behalf when the password prompt is detected.
*/
password?: string;
/**
 * The regular expression to use when waiting for the username prompt. This parameter is optional. If not specified, a reasonable default built into Guacamole will be used. The regular expression must be written in the POSIX ERE dialect (the dialect typically used by egrep).
*/
"username-regex"?: string;
/**
 * The regular expression to use when waiting for the password prompt. This parameter is optional. If not specified, a reasonable default built into Guacamole will be used. The regular expression must be written in the POSIX ERE dialect (the dialect typically used by egrep).
*/
"password-regex"?: string;
/**
 * The regular expression to use when detecting that the login attempt has succeeded. This parameter is optional. If specified, the terminal display will not be shown to the user until text matching this regular expression has been received from the telnet server. The regular expression must be written in the POSIX ERE dialect (the dialect typically used by egrep).
*/
"login-success-regex"?: string;
/**
 * The regular expression to use when detecting that the login attempt has failed. This parameter is optional. If specified, the connection will be closed with an explicit login failure error if text matching this regular expression has been received from the telnet server. The regular expression must be written in the POSIX ERE dialect (the dialect typically used by egrep).
 */
"login-failure-regex"?: string;
}

export interface kubernetes_settings extends common_setting, kubernetes_unencrypted_settings {
/**
 * The hostname or IP address of the Kubernetes server that Guacamole should connect to.
 */
hostname: string;
/**
 * The port the Kubernetes server is listening on for API connections. This parameter is optional. If omitted, port 8080 will be used by default.
*/
port: number;
/**
 * The name of the Kubernetes pod containing with the container being attached to.
*/
pod?: string;
/**
 * The name of the container to attach to. This parameter is optional. If omitted, the first container in the pod will be used.
*/
container?: string
/**
 * The command to run within the container, with input and output attached to this command’s process. This parameter is optional. If omitted, no command will be run, and input/output will instead be attached to the main process of the container.
 *
 * When this parameter is specified, the behavior of the connection is analogous to running kubectl exec. When omitted, the behavior is analogous to running kubectl attach.
*/
"exec-command"?: string;
/**
 * If set to “true”, SSL/TLS will be used to connect to the Kubernetes server. This parameter is optional. By default, SSL/TLS will not be used.
*/
"use-ssl"?: boolean;
/**
 * The certificate to use if performing SSL/TLS client authentication to authenticate with the Kubernetes server, in PEM format. This parameter is optional. If omitted, SSL client authentication will not be performed.
*/
"client-cert"?: string;
/**
 * The key to use if performing SSL/TLS client authentication to authenticate with the Kubernetes server, in PEM format. This parameter is optional. If omitted, SSL client authentication will not be performed.
*/
"client-key"?: string;
/**
 * The certificate of the certificate authority that signed the certificate of the Kubernetes server, in PEM format. This parameter is optional. If omitted, verification of the Kubernetes server certificate will use only system-wide certificate authorities.
*/
"ca-cert"?: string;
/**
 * If set to “true”, the validity of the SSL/TLS certificate used by the Kubernetes server will be ignored if it cannot be validated. This parameter is optional. By default, SSL/TLS certificates are validated.
*/
"ignore-cert"?: boolean;
}
  

export interface common_setting{
    /**
         Guacamole provides bidirectional access to the clipboard by default for all supported protocols. 
        For protocols that don’t inherently provide a clipboard, Guacamole implements its own clipboard. 
        This behavior can be overridden on a per-connection basis with the disable-copy and disable-paste parameters.
    */

    /**
     * If set to “true”, text copied within the remote desktop session will not be accessible by the user at the browser side of the Guacamole session, and will be usable only within the remote desktop. This parameter is optional. By default, the user will be given access to the copied text.
    */
    "disable-copy"?: boolean; 
    /**
     * If set to “true”, text copied at the browser side of the Guacamole session will not be accessible within the remote ddesktop session. This parameter is optional. By default, the user will be able to paste data from outside the browser within the remote desktop session.
     * */
    "disable-paste"?: boolean;

    /**
    
        Guacamole can provide file transfer over SFTP even when the remote desktop is otherwise being accessed through a different protocol, 
        like VNC or RDP. If SFTP is enabled on a Guacamole RDP connection, users will be able to upload and download files as described in Using 
        Guacamole.

        This support is independent of the file transfer that may be provided by the protocol in use, like RDP’s own “drive redirection” (RDPDR), 
        and is particularly useful for remote desktop servers which do not support file transfer features.

    */


    /**
     * Whether file transfer should be enabled. If set to “true”, the user will be allowed to upload or download files from the specified server using SFTP. If omitted, SFTP will be disabled.
    */
    "enable-sftp"?: boolean;
    /**
     * The hostname or IP address of the server hosting SFTP. This parameter is optional. If omitted, the hostname of the remote desktop server associated with the connection will be used.
    */
    "sftp-hostname"?: string;
    /**
     * The port the SSH server providing SFTP is listening on, usually 22. This parameter is optional. If omitted, the standard port of 22 will be used.
    */
    "sftp-port"?: number;
    /**
     * The known hosts entry for the SFTP server. This parameter is optional, and, if not provided, no verification of SFTP host identity will be done. If the parameter is provided the identity of the server will be checked against the data.
     *
     * The format of this parameter is that of a single entry from an OpenSSH known_hosts file.
     * For more information, please see [SSH Host Verification](https://guacamole.incubator.apache.org/doc/gug/configuring-guacamole.html#ssh-host-verification).
    */
    "sftp-host-key"?: string;
    /**
     * The username to authenticate as when connecting to the specified SSH server for SFTP. This parameter is optional if a username is specified for the remote desktop connection. If omitted, the username specified for the remote desktop connection will be used.
    */
    "sftp-username"?: string;
    /**
     * The password to use when authenticating with the specified SSH server for SFTP.
    */
    "sftp-password"?: string;
    /**
     * The entire contents of the private key to use for public key authentication. If this parameter is not specified, public key authentication will not be used. The private key must be in OpenSSH format, as would be generated by the OpenSSH ssh-keygen utility.
    */
    "sftp-private-key"?: string;
    /**
     * The passphrase to use to decrypt the private key for use in public key authentication. This parameter is not needed if the private key does not require a passphrase.
    */
    "sftp-passphrase"?: string;
    /**
     * The directory to upload files to if they are simply dragged and dropped, and thus otherwise lack a specific upload location. This parameter is optional. If omitted, the default upload location of the SSH server providing SFTP will be used.
    */
    "sftp-directory"?: string;
    /**
     * The directory to expose to connected users via Guacamole’s [Using the file browser](https://guacamole.incubator.apache.org/doc/gug/using-guacamole.html#file-browser). If omitted, the root directory will be used by default.
    */
    "sftp-root-directory"?: string;
    /**
     * The interval in seconds at which to send keepalive packets to the SSH server for the SFTP connection. This parameter is optional. If omitted, the default of 0 will be used, disabling sending keepalive packets. The minimum value is 2.
    */
    "sftp-server-alive-interval"?: number;
    /**
     * If set to true downloads from the remote system to the client (browser) will be disabled. The default is false, which means that downloads will be enabled.
     * If sftp is not enabled, this parameter will be ignored.
    */
    "sftp-disable-download"?: boolean;
    /**
     * If set to true uploads from the client (browser) to the remote system will be disabled. The default is false, which means that uploads will be enabled.
     * If sftp is not enabled, this parameter will be ignored.
     * */
    "sftp-disable-upload"?: boolean;

    /** 
        Sessions of all supported protocols can be recorded graphically. These recordings take the form of Guacamole protocol dumps and are 
        recorded automatically to a specified directory. Recordings can be subsequently played back directly in the browser from the connection 
        history screen or translated to a normal video stream using the guacenc utility provided with guacamole-server.
        
        For example, to produce a video called NAME.m4v from the recording “NAME”, you would run:

        ```console
            guacenc /path/to/recording/NAME
            The guacenc utility has additional options for overriding default behavior, including tweaking the output format, which are documented in 
            detail within the manpage:
        ```

        ```console
            man guacenc
        ```
        If recording of key events is explicitly enabled using the recording-include-keys parameter, recordings can also be translated into 
        human-readable interpretations of the keys pressed during the session using the guaclog utility. The usage of guaclog is analogous to 
        guacenc, and results in the creation of a new text file containing the interpreted events:

        ```console
            guaclog /path/to/recording/NAME
            guaclog: INFO: Guacamole input log interpreter (guaclog) version 1.5.3
            guaclog: INFO: 1 input file(s) provided.
            guaclog: INFO: Writing input events from "/path/to/recording/NAME" to "/path/to/recording/NAME.txt" ...
            guaclog: INFO: All files interpreted successfully.
        ```
        
        Guacamole will never overwrite an existing recording. If necessary, a numeric suffix like “.1”, “.2”, “.3”, etc. will be appended to to 
        avoid overwriting an existing recording. If even appending a numeric suffix does not help, the session will simply not be recorded.
    */

    /**
     * The directory in which screen recording files should be created. If a graphical recording needs to be created, then this parameter is required. Specifying this parameter enables graphical screen recording. If this parameter is omitted, no graphical recording will be created.
    */
    "recording-path"?: string;
    /**
     * If set to “true”, the directory specified by the recording-path parameter will automatically be created if it does not yet exist. Only the final directory in the path will be created - if other directories earlier in the path do not exist, automatic creation will fail, and an error will be logged.
     *
     * This parameter is optional. By default, the directory specified by the recording-path parameter will not automatically be created, and attempts to create recordings within a non-existent directory will be logged as errors.
     *
     * This parameter only has an effect if graphical recording is enabled. If the recording-path is not specified, graphical session recording will be disabled, and this parameter will be ignored.
    */
    "create-recording-path"?: boolean;
    /**
     * The filename to use for any created recordings. This parameter is optional. If omitted, the value “recording” will be used instead.
     *
     * This parameter only has an effect if graphical recording is enabled. If the recording-path is not specified, graphical session recording will be disabled, and this parameter will be ignored.
    */
    "recording-name"?: string;
    /**
     * If set to “true”, graphical output and other data normally streamed from server to client will be excluded from the recording, producing a recording which contains only user input events. This parameter is optional. If omitted, graphical output will be included in the recording.
     *
     * This parameter only has an effect if graphical recording is enabled. If the recording-path is not specified, graphical session recording will be disabled, and this parameter will be ignored.
    */
    "recording-exclude-output"?: boolean;
    /**
     * If set to “true”, user mouse events will be excluded from the recording, producing a recording which lacks a visible mouse cursor. This parameter is optional. If omitted, mouse events will be included in the recording.
     *
     * This parameter only has an effect if graphical recording is enabled. If the recording-path is not specified, graphical session recording will be disabled, and this parameter will be ignored.
    */
    "recording-exclude-mouse"?: boolean;
    /**
     * If set to “true”, user key events will be included in the recording. The recording can subsequently be passed through the guaclog utility to produce a human-readable interpretation of the keys pressed during the session. This parameter is optional. If omitted, key events will be not included in the recording.
     *
     * This parameter only has an effect if graphical recording is enabled. If the recording-path is not specified, graphical session recording will be disabled, and this parameter will be ignored.
     *
     */
    "recording-include-keys"?: boolean;

    /**
        The full, raw text content of SSH sessions, including timing information, can be recorded automatically to a specified directory. 
        This recording, also known as a “typescript”, will be written to two files within the directory specified by typescript-path: NAME, 
        which contains the raw text data, and NAME.timing, which contains timing information, where NAME is the value provided for the 
        typescript-name parameter.

        This format is compatible with the format used by the standard UNIX script command, and can be replayed using scriptreplay (if installed). 
        For example, to replay a typescript called “NAME”, you would run:

        ```console
        scriptreplay NAME.timing NAME
        ```

        Important
        Guacamole will never overwrite an existing recording. If necessary, a numeric suffix like “.1”, “.2”, “.3”, etc. will be appended to 
        NAME to avoid overwriting an existing recording. If even appending a numeric suffix does not help, the session will simply not be recorded.
    */

    /**
     * The directory in which typescript files should be created. If a typescript needs to be recorded, this parameter is required. Specifying this parameter enables typescript recording. If this parameter is omitted, no typescript will be recorded.
    */
    "typescript-path"?: string;
    /**
     * If set to “true”, the directory specified by the typescript-path parameter will automatically be created if it does not yet exist. Only the final directory in the path will be created - if other directories earlier in the path do not exist, automatic creation will fail, and an error will be logged.
     *
     * This parameter is optional. By default, the directory specified by the typescript-path parameter will not automatically be created, and attempts to record typescripts in a non-existent directory will be logged as errors.
     *
     * This parameter only has an effect if typescript recording is enabled. If the typescript-path is not specified, recording of typescripts will be disabled, and this parameter will be ignored.
    */
    "create-typescript-path"?: boolean;
    /**
     * The base filename to use when determining the names for the data and timing files of the typescript. This parameter is optional. If omitted, the value “typescript” will be used instead.
     *
     * Each typescript consists of two files which are created within the directory specified by typescript-path: NAME, which contains the raw text data, and NAME.timing, which contains timing information, where NAME is the value provided for the typescript-name parameter.
     *
     * This parameter only has an effect if typescript recording is enabled. If the typescript-path is not specified, recording of typescripts will be disabled, and this parameter will be ignored.
    */
    "typescript-name"?: string;

    /**
        In most cases, the default behavior for a terminal works without modification. However, when connecting to certain systems, 
        particularly operating systems other than Linux, the terminal behavior may need to be tweaked to allow it to operate properly. 
        The settings in this section control that behavior.
    */


    /**
     * This parameter controls the ASCII code that the backspace key sends to the remote system. Under most circumstances this should not need to be adjusted; however, if, when pressing the backspace key, you see control characters (often either ^? or ^H) instead of seeing the text erased, you may need to adjust this parameter. By default the terminal sends ASCII code 127 (Delete) if this option is not set.
    */
    backspace?: string;
    /**
     * This parameter sets the terminal emulator type string that is passed to the server. This parameter is optional. If not specified, “linux” is used as the terminal emulator type by default.
    */
    "terminal-type"?: string;

    /**
    
        If Guacamole is being used in part to automate an SSH, telnet, or other terminal session, it can be useful to provide 
        input directly from JavaScript as a raw stream of data, rather than attempting to translate data into keystrokes. 
        This can be done through opening a pipe stream named “STDIN” within the connection using the createPipeStream() 
        function of Guacamole.Client:

        ```
        var outputStream = client.createPipeStream('text/plain', 'STDIN');
        ```

        The resulting Guacamole.OutputStream can then be used to stream data directly to the input of the terminal session, as if typed by the user:

        ```
        // Wrap output stream in writer
        var writer = new Guacamole.StringWriter(outputStream);

        // Send text
        writer.sendText("hello");

        // Send more text
        writer.sendText("world");

        // Close writer and stream
        writer.sendEnd();
        ```
    */

    /**
     * The color scheme to use for the terminal session. It consists of a semicolon-separated series of name-value pairs. Each name-value pair is separated by a colon and assigns a value to a color in the terminal emulator palette. For example, to use blue text on white background by default, and change the red color to a purple shade, you would specify:
     *
     * 
     *   ```
     *   foreground: rgb:00/00/ff;
     *   background: rgb:ff/ff/ff;
     *   color9: rgb:80/00/80
     *   ```
     * This format is similar to the color configuration format used by Xterm, so Xterm color configurations can be easily adapted for Guacamole. This parameter is optional. If not specified, Guacamole will render text as gray over a black background.
     * 
     * Possible color names are:
     *   foreground
     *   Set the default foreground color.
     *
     *   background
     *   Set the default background color.
     *
     *   colorN
     *   Set the color at index N on the Xterm 256-color palette. For example, color9 refers to the red color.
     *
     *   Possible color values are:
     *
     *       rgb:RR/GG/BB
     *       Use the specified color in RGB format, with each component in hexadecimal. For example, rgb:ff/00/00 specifies the color red. Note that each hexadecimal component can be one to four digits, but the effective values are always zero-extended or truncated to two digits; for example, rgb:f/8/0, rgb:f0/80/00, and rgb:f0f/808/00f all refer to the same effective color.
     *
     *       colorN
     *       Use the color currently assigned to index N on the Xterm 256-color palette. For example, color9 specifies the current red color. Note that the color value is used rather than the color reference, so if color9 is changed later in the color scheme configuration, that new color will not be reflected in this assignment.
     *
     *   For backward compatibility, Guacamole will also accept four special values as the color scheme parameter:
     *
     *   black-white
     *   Black text over a white background.
     *
     *   gray-black
     *   Gray text over a black background. This is the default color scheme.
     *
     *   green-black
     *   Green text over a black background.
     *
     *   white-black
     *   White text over a black background.
     */
    "color-scheme"?: string;

/**
 * The name of the font to use. This parameter is optional. If not specified, the default of “monospace” will be used instead.
*/
"font-name"?: string;
/**
 * The size of the font to use, in points. This parameter is optional. If not specified, the default of 12 will be used instead.
*/
"font-size"?: number;
/**
 * The maximum number of rows to allow within the terminal scrollback buffer. This parameter is optional. If not specified, the scrollback buffer will be limited to a maximum of 1000 rows.
*/
scrollback?: number;
/**
Guacamole implements the support to send a “magic wake-on-lan packet” to a remote host prior to attempting to establish a connection with the host. The below parameters control the behavior of this functionality, which is disabled by default.

Important
There are several factors that can impact the ability of Wake-on-LAN (WoL) to function correctly, many of which are outside the scope of Guacamole configuration. If you are configuring WoL within Guacamole you should also be familiar with the other components that need to be configured in order for it to function correctly.
*/

/**
 * If set to “true”, Guacamole will attempt to send the Wake-On-LAN packet prior to establishing a connection. This parameter is optional. By default, Guacamole will not send the WoL packet. Enabling this option requires that the wol-mac-addr parameter also be configured, otherwise the WoL packet will not be sent.
*/
"wol-send-packet"?: boolean;
/**
 * This parameter configures the MAC address that Guacamole will use in the magic WoL packet to attempt to wake the remote system. If wol-send-packet is enabled, this parameter is required or else the WoL packet will not be sent.
*/
"wol-mac-addr"?: string;
/**
 * This parameter configures the IPv4 broadcast address or IPv6 multicast address that Guacamole will send the WoL packet to in order to wake the host. This parameter is optional. If no value is provided, the default local IPv4 broadcast address (255.255.255.255) will be used.
*/
"wol-broadcast-addr"?: string;
/**
 * This parameter configures the UDP port that will be set in the WoL packet. In most cases the UDP port isn’t processed by the system that will be woken up; however, there are certain cases where it is useful for the port to be set, as in situations where a router is listening for the packet and can make routing decisions depending upon the port that is used. If not configured the default UDP port 9 will be used.
*/
"wol-udp-port"?: number;
/**
 * By default after the WoL packet is sent Guacamole will attempt immediately to connect to the remote host. It may be desirable in certain scenarios to have Guacamole wait before the initial connection in order to give the remote system time to boot. Setting this parameter to a positive value will cause Guacamole to wait the specified number of seconds before attempting the initial connection. This parameter is optional.
*/
"wol-wait-time"?: number;
}

export interface vnc_unencrypted_settings {
    /**
   * The number of times to retry connecting before giving up and returning an error. In the case of a reverse connection, this is the number of times the connection process is allowed to time out.
   */
    autoretry?: number;
    /**
     * The color depth to request, in bits-per-pixel. This parameter is optional. If specified, this must be either 8, 16, 24, or 32. Regardless of what value is chosen here, if a particular update uses less than 256 colors, Guacamole will always send that update as a 256-color PNG.
     */
    "color-depth"?: 8 | 16 | 24 | 32;
    /**
     * If the colors of your display appear wrong (blues appear orange or red, etc.), it may be that your VNC server is sending image data incorrectly, and the red and blue components of each color are swapped. If this is the case, set this parameter to “true” to work around the problem. This parameter is optional.
     */
    "swap-red-blue"?: boolean;
    /**
     * If set to “remote”, the mouse pointer will be rendered remotely, and the local position of the mouse pointer will be indicated by a small dot. A remote mouse cursor will feel slower than a local cursor, but may be necessary if the VNC server does not support sending the cursor image to the client.
     */
    cursor?: "remote";
    /**
     * A space-delimited list of VNC encodings to use. The format of this parameter is dictated by libvncclient and thus doesn’t really follow the form of other Guacamole parameters. This parameter is optional, and libguac-client-vnc will use any supported encoding by default.
  
        Beware that this parameter is intended to be replaced with individual, encoding-specific parameters in a future release.
        */
    encodings?: string;
    /**
     * Whether this connection should be read-only. If set to “true”, no input will be accepted on the connection at all. Users will only see the desktop and whatever other users using that same desktop are doing. This parameter is optional.
     */
    "read-only"?: boolean;
    /**
     * Whether this connection should only use lossless compression for graphical updates. If set to “true”, lossy compression will not be used. This parameter is optional. By default, lossy compression will be used when heuristics determine that it would likely outperform lossless compression.
     */
    "force-lossless"?: boolean;
    /**
     * The destination host to request when connecting to a VNC proxy such as UltraVNC Repeater. This is only necessary if the VNC proxy in use requires the connecting user to specify which VNC server to connect to. If the VNC proxy automatically connects to a specific server, this parameter is not necessary.
     */
    "dest-host"?: string;
    /**
     * Whether reverse connection should be used. If set to “true”, instead of connecting to a server at a given hostname and port, guacd will listen on the given port for inbound connections from a VNC server.
     */
    "reverse-connect"?: boolean;
    /**
     * If reverse connection is in use, the maximum amount of time to wait for an inbound connection from a VNC server, in milliseconds. If blank, the default value is 5000 (five seconds).
     */
    "listen-timeout"?: number;
    /**
     * If set to “true”, audio support will be enabled, and a second connection for PulseAudio will be made in addition to the VNC connection. By default, audio support within VNC is disabled.
     */
    "enable-audio"?: boolean;
    /**
     * The name of the PulseAudio server to connect to. This will be the hostname of the computer providing audio for your connection via PulseAudio, most likely the same as the value given for the hostname parameter.
  
        If this parameter is omitted, the default PulseAudio device will be used, which will be the PulseAudio server running on the same machine as guacd.
        */
    "audio-servername"?: string;
    /**
     * The encoding to assume for the VNC clipboard. This parameter is optional. By default, the standard encoding ISO 8859-1 will be used. Only use this parameter if you are sure your VNC server supports other encodings beyond the standard ISO 8859-1.
  
        Possible values are:
  
        ISO8859-1
        ISO 8859-1 is the clipboard encoding mandated by the VNC standard, and supports only basic Latin characters. Unless your VNC server specifies otherwise, this encoding is the only encoding guaranteed to work.
  
        UTF-8
        UTF-8 - the most common encoding used for Unicode. Using this encoding for the VNC clipboard violates the VNC specification, but some servers do support this. This parameter value should only be used if you know your VNC server supports this encoding.
  
        UTF-16
        UTF-16 - a 16-bit encoding for Unicode which is not as common as UTF-8, but still widely used. Using this encoding for the VNC clipboard violates the VNC specification. This parameter value should only be used if you know your VNC server supports this encoding.
  
        CP1252
        Code page 1252 - a Windows-specific encoding for Latin characters which is mostly a superset of ISO 8859-1, mapping some additional displayable characters onto what would otherwise be control characters. Using this encoding for the VNC clipboard violates the VNC specification. This parameter value should only be used if you know your VNC server supports this encoding.
        * 
        */
    "clipboard-encoding"?: "ISO8859-1" | "UTF-8" | "UTF-16" | "CP1252"
}

export interface rdp_unencrypted_settings {
/**
 * The type of line ending normalization to apply to text within the clipboard, if any. By default, line ending normalization is not applied.
 
    Possible values are:

    preserve
    Preserve all line endings within the clipboard exactly as they are, performing no normalization whatsoever. This is the default.

    unix
    Automatically transform all line endings within the clipboard to Unix-style line endings (LF). This format of line ending is the format used by both Linux and Mac.

    windows
    Automatically transform all line endings within the clipboard to Windows-style line endings (CRLF).
    */
"normalize-clipboard"?: "preserve" | "unix" | "windows";
/**
 * The server-side keyboard layout. This is the layout of the RDP server and has nothing to do with the keyboard layout in use on the client. The Guacamole client is independent of keyboard layout. The RDP protocol, however, is not independent of keyboard layout, and Guacamole needs to know the keyboard layout of the server in order to send the proper keys when a user is typing.
 
    Possible values are generally in the format LANGUAGE-REGION-VARIANT, where LANGUAGE is the standard two-letter language code for the primary language associated with the layout, REGION is a standard representation of the location that the keyboard is used (the two-letter country code, when possible), and VARIANT is the specific keyboard layout variant (such as “qwerty”, “qwertz”, or “azerty”):

    | Keyboard layout			    | Parameter value   | 
    | ------------------------------| -----------------:|
    | Brazilian (Portuguese)        | pt-br-qwerty      |
    | English (UK)                  | en-gb-qwerty      |
    | English (US)                  | en-us-qwerty      |
    | French                        | fr-fr-azerty      |
    | French (Belgian)              | fr-be-azerty      |
    | French (Swiss)                | fr-ch-qwertz      |
    | German                        | de-de-qwertz      |
    | German (Swiss)                | de-ch-qwertz      |
    | Hungarian                     | hu-hu-qwertz      |
    | Italian                       | it-it-qwerty      |
    | Japanese                      | ja-jp-qwerty      |
    | Norwegian                     | no-no-qwerty      |
    | Spanish                       | es-es-qwerty      |
    | Spanish (Latin American)      | es-latam-qwerty   |
    | Swedish                       | sv-se-qwerty      |
    | Turkish-Q                     | tr-tr-qwerty      |

    If you server’s keyboard layout is not yet supported, and it is not possible to set your server to use a supported layout, the failsafe layout may be used to force Unicode events to be used for all input, however beware that doing so may prevent keyboard shortcuts from working as expected.
    * 
    */
"server-layout"?: string;
/**
 * The timezone that the client should send to the server for configuring the local time display of that server. The format of the timezone is in the standard IANA key zone format, which is the format used in UNIX/Linux. This will be converted by RDP into the correct format for Windows.
 
    The timezone is detected and will be passed to the server during the handshake phase of the connection, and may used by protocols, like RDP, that support it. This parameter can be used to override the value detected and passed during the handshake, or can be used in situations where guacd does not support passing the timezone parameter during the handshake phase (guacd versions prior to 1.3.0).

    Support for forwarding the client timezone varies by RDP server implementation. For example, with Windows, support for forwarding timezones is only present in Windows Server with Remote Desktop Services (RDS, formerly known as Terminal Services) installed. Windows Server installations in admin mode, along with Windows workstation versions, do not allow the timezone to be forwarded. Other server implementations, for example, xrdp, may not implement this feature at all. Consult the documentation for the RDP server to determine whether or not this feature is supported.
    */
timezone?: string;
/**
 * The color depth to request, in bits-per-pixel. This parameter is optional. If specified, this must be either 8, 16, 24, or 32. Regardless of what value is chosen here, if a particular update uses less than 256 colors, Guacamole will always send that update as a 256-color PNG.
 */
"color-depth"?: 8 | 16 | 24 | 32;
/**
 * The width of the display to request, in pixels. This parameter is optional. If this value is not specified, the width of the connecting client display will be used instead.
 */
width?: number;
/**
 * The height of the display to request, in pixels. This parameter is optional. If this value is not specified, the height of the connecting client display will be used instead.
 */
height?: number;
/**
 * The desired effective resolution of the client display, in DPI. This parameter is optional. If this value is not specified, the resolution and size of the client display will be used together to determine, heuristically, an appropriate resolution for the RDP session.
 */
dpi?: number;
/**
 * The method to use to update the RDP server when the width or height of the client display changes. This parameter is optional. If this value is not specified, no action will be taken when the client display changes size.
 
    Normally, the display size of an RDP session is constant and can only be changed when initially connecting. As of RDP 8.1, the “Display Update” channel can be used to request that the server change the display size. For older RDP servers, the only option is to disconnect and reconnect with the new size.

    Possible values are:

    display-update
    Uses the “Display Update” channel added with RDP 8.1 to signal the server when the client display size has changed.

    reconnect
    Automatically disconnects the RDP session when the client display size has changed, and reconnects with the new size.
    * 
    */
"resize-method"?: "display-update" | "reconnect";
/**
 * Whether this connection should only use lossless compression for graphical updates. If set to “true”, lossy compression will not be used. This parameter is optional. By default, lossy compression will be used when heuristics determine that it would likely outperform lossless compression.
 * 
 */
"force-lossless"?: boolean;
/**
 * Audio is enabled by default in both the client and in libguac-client-rdp. If you are concerned about bandwidth usage, or sound is causing problems, you can explicitly disable sound by setting this parameter to “true”.
*/
"disable-audio"?: boolean;
/** 
 * If set to “true”, audio input support (microphone) will be enabled, leveraging the standard “AUDIO_INPUT” channel of RDP. By default, audio input support within RDP is disabled.
*/
"enable-audio-input"?: boolean;
/**
 * If set to “true”, support for multi-touch events will be enabled, leveraging the standard “RDPEI” channel of RDP. By default, direct RDP support for multi-touch events is disabled.
 * 
 * Enabling support for multi-touch allows touch interaction with applications inside the RDP session, however the touch gestures available will depend on the level of touch support of those applications and the OS.
 * 
 * If multi-touch support is not enabled, pointer-type interaction with applications inside the RDP session will be limited to mouse or emulated mouse events.
*/
"enable-touch"?: boolean;
/**
 * Printing is disabled by default, but with printing enabled, RDP users can print to a virtual printer that sends a PDF containing the document printed to the Guacamole client. Enable printing by setting this parameter to “true”.
 * 
 * Printing support requires GhostScript to be installed. If guacd cannot find the gs executable when printing, the print attempt will fail.
*/
"enable-printing"?: boolean;
/**
* File transfer is disabled by default, but with file transfer enabled, RDP users can transfer files to and from a virtual drive which persists on the Guacamole server. Enable file transfer support by setting this parameter to “true”.
* 
* Files will be stored in the directory specified by the “drive-path” parameter, which is required if file transfer is enabled.
*/
"enable-drive"?: boolean;
/**
 * If set to true downloads from the remote server to client (browser) will be disabled. This includes both downloads done via the hidden Guacamole menu, as well as using the special “Download” folder presented to the remote server. The default is false, which means that downloads will be allowed.
* 
* If file transfer is not enabled, this parameter is ignored.
*/
"disable-download"?: boolean;
/**
 * If set to true, uploads from the client (browser) to the remote server location will be disabled. The default is false, which means uploads will be allowed if file transfer is enabled.
*
* If file transfer is not enabled, this parameter is ignored.
*/
"disable-upload"?: boolean;
/**
 * If set to “true”, enables rendering of the desktop wallpaper. By default, wallpaper will be disabled, such that unnecessary bandwidth need not be spent redrawing the desktop.
 */
"enable-wallpaper"?: boolean;
/**
 * If set to “true”, enables use of theming of windows and controls. By default, theming within RDP sessions is disabled.
*/
"enable-theming"?: boolean;
/**
 * If set to “true”, text will be rendered with smooth edges. Text over RDP is rendered with rough edges by default, as this reduces the number of colors used by text, and thus reduces the bandwidth required for the connection.
*/
"enable-font-smoothing"?: boolean;
/**
 * If set to “true”, the contents of windows will be displayed as windows are moved. By default, the RDP server will only draw the window border while windows are being dragged.
*/
"enable-full-window-drag"?: boolean;
/**
 * If set to “true”, graphical effects such as transparent windows and shadows will be allowed. By default, such effects, if available, are disabled.
*/
"enable-desktop-composition"?: boolean;
/*
* If set to “true”, menu open and close animations will be allowed. Menu animations are disabled by default.
*/
"enable-menu-animations"?: boolean;
/**
 * In certain situations, particularly with RDP server implementations with known bugs, it is necessary to disable RDP’s built-in bitmap caching functionality. This parameter allows that to be controlled in a Guacamole session. If set to “true” the RDP bitmap cache will not be used.
*/
"disable-bitmap-caching"?: boolean;
/**
 * RDP normally maintains caches of regions of the screen that are currently not visible in the client in order to accelerate retrieval of those regions when they come into view. This parameter, when set to “true,” will disable caching of those regions. This is usually only useful when dealing with known bugs in RDP server implementations and should remain enabled in most circumstances.
*/
"disable-offscreen-caching"?: boolean;
/**
 * In addition to screen regions, RDP maintains caches of frequently used symbols or fonts, collectively known as “glyphs.” As with bitmap and offscreen caching, certain known bugs in RDP implementations can cause performance issues with this enabled, and setting this parameter to “true” will disable that glyph caching in the RDP session.
 * 
 * Glyph caching is currently universally disabled, regardless of the value of this parameter, as glyph caching support is not considered stable by FreeRDP as of the FreeRDP 2.0.0 release. See: GUACAMOLE-1191.
*/
"disable-glyph-caching"?: boolean;
}

export interface ssh_unencrypted_settings {
/**
 * The specific locale to request for the SSH session. This parameter is optional and may be any value accepted by the LANG environment variable of the SSH server. If not specified, the SSH server’s default locale will be used.
 * 
 * As this parameter is sent to the SSH server using the LANG environment variable, the parameter will only have an effect if the SSH server allows the LANG environment variable to be set by SSH clients.
*/
locale?: string;
/**
 * This parameter allows you to control the timezone that is sent to the server over the SSH connection, which will change the way local time is displayed on the server.
 * 
 * The mechanism used to do this over SSH connections is by setting the TZ variable on the SSH connection to the timezone specified by this parameter. This means that the SSH server must allow the TZ variable to be set/overriden - many SSH server implementations have this disabled by default. To get this to work, you may need to modify the configuration of the SSH server and explicitly allow for TZ to be set/overriden.
 * 
 * The available values of this parameter are standard IANA key zone format timezones, and the value will be sent directly to the server in this format.
*/
timezone?: string;
/**
 * Whether file transfer should be enabled. If set to “true”, the user will be allowed to upload or download files from the SSH server using SFTP. Guacamole includes the guacctl utility which controls file downloads and uploads when run on the SSH server by the user over the SSH connection.
*/
"enable-sftp"?: boolean;
/**
 * If set to true downloads from the remote system to the client (browser) will be disabled. The default is false, which means that downloads will be enabled.
 * 
 * If SFTP is not enabled, this parameter will be ignored.
*/
"sftp-disable-download"?: boolean;
/**
 * If set to true uploads from the client (browser) to the remote system will be disabled. The default is false, which means that uploads will be enabled.
 * 
 * If SFTP is not enabled, this parameter will be ignored.
*/
"sftp-disable-upload"?: boolean;
}

export interface telnet_unencrypted_settings {

}

export interface kubernetes_unencrypted_settings {
/**
 * The name of the Kubernetes namespace of the pod containing the container being attached to. This parameter is optional. If omitted, the namespace “default” will be used.
*/
    namespace?: string;
}

export interface vnc_optional_settings extends Omit<vnc_settings, 'hostname'|'port'> {
    /**
     * The hostname or IP address of the VNC server Guacamole should connect to.
     */
    hostname?: string;
    /**
     * The port the VNC server is listening on, usually 5900 or 5900 + display number. For example, if your VNC server is serving display number 1 (sometimes written as :1), your port number here would be 5901.
     */
    port?: string;
}

export interface rdp_optional_settings extends Omit<rdp_settings, 'hostname'> {
    /**
     * The hostname or IP address of the VNC server Guacamole should connect to.
     */
    hostname?: string;
}

export interface ssh_optional_settings extends Omit<ssh_settings, 'hostname'> {
    /**
     * The hostname or IP address of the VNC server Guacamole should connect to.
     */
    hostname?: string;
}

export interface telnet_optional_settings extends Omit<telnet_settings, 'hostname'> {
    /**
     * The hostname or IP address of the VNC server Guacamole should connect to.
     */
    hostname?: string;
}

export interface kubernetes_optional_settings extends Omit<telnet_settings, 'hostname'> {
    /**
     * The hostname or IP address of the Kubernetes server that Guacamole should connect to.
     */
    hostname?: string;
    /**
     * The port the Kubernetes server is listening on for API connections. This parameter is optional. If omitted, port 8080 will be used by default.
    */
    port?: number;
}


export interface log_settings{
    level: logLevel;
    stdLog: any;
    errorLog: any;
}

export interface vncGuacLiteOptions extends baseOptions {
    type: 'vnc';
    settings?: vnc_settings;
    defaultSettings: vnc_optional_settings;
    allowedUnencryptedConnectionSettings: Array<vncUnencryptOption>;
}

export interface rdpGuacLiteOptions extends baseOptions {
    type: 'rdp';
    settings?: rdp_settings;
    defaultSettings: rdp_optional_settings;
    allowedUnencryptedConnectionSettings:  Array<rdpUnencryptOption>;
}

export interface sshGuacLiteOptions extends baseOptions {
    type: 'ssh';
    settings?: ssh_settings;
    defaultSettings: ssh_optional_settings;
    allowedUnencryptedConnectionSettings:  Array<sshUnencryptOption>;
}

export interface telnetGuacLiteOptions extends baseOptions {
    type: 'telnet';
    settings?: telnet_settings;
    defaultSettings: telnet_optional_settings;
    allowedUnencryptedConnectionSettings:  Array<telnetUnencryptOption>;
}

export interface kubernetesGuacLiteOptions extends baseOptions {
    type: 'kubernetes';
    settings?: kubernetes_settings;
    defaultSettings: kubernetes_optional_settings;
    allowedUnencryptedConnectionSettings:  Array<kubernetesUnencryptOption>;
}

export interface baseOptions {
    maxInactivityTime?: number;
}

export type guacLiteOptions = vncGuacLiteOptions | rdpGuacLiteOptions | sshGuacLiteOptions | telnetGuacLiteOptions | kubernetesGuacLiteOptions;

export interface guacdOptions {
    host?: string;
    port: number;
}

export interface agent_options {
    id: string;
    host: string;
    preConnect?: preConnect;
    socket_opts: Partial<ManagerOptions & SocketOptions>;
}

export interface preConnect {
    (options: guacLiteOptions, callback: (error: any, options: guacLiteOptions) => void): Promise<void>;    
}