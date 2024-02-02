# guacamole-gateway-ts

## Synopsis
Typescript *guacamole-gateway-ts* is a NodeJS replacement for *guacamole-client* (server-side Java servlet).
Guacamole is a RDP/VNC client for HTML5 browsers. This is a fork of vadimpronin excellent work on guacamole-lite.

This solution allows dynamic control of encryption and decryption inside your node. This also requires an express server and socket.io. 

This diagram describes the architecture of Guacamole and the role of *guacamole-gateway-ts* in it:
![Chart](https://github.com/smeagol002/assets/blob/main/pictures/RemoteDesktop.jpg?raw=true)


## Installation

```
npm install --save guacamole-gateway-ts
```

To connect to *guacamole-gateway-ts* as a client please see the Angular component 'guacamole-gateway-client'
[NPM Link](https://www.npmjs.com/package/guacamole-gateway-client)



### Setting up the Server 


```typescript
import { Server as httpsServer, createServer } from 'https';		//Secure for SSL
import express, { Request, Response, NextFunction } from "express";
import { SocketIOGatewayServer, logLevel, log_settings, preProcess } from 'guacamole-gateway-ts';

    var listen_port = 4823;
    var app = express();
    var options = {
        key: readFileSync("/{{path to key}}/key.pem", "utf8"),
        cert: readFileSync("/{{path to key}}/certbundle.pem", "utf8"),
    };
    var server: httpsServer = createServer(options, app);

    const guacdOpt: guacdOptions = {
        port: 4822 // default guacd port
    };

    //Setting up log options is optional.
    const log_options: log_settings = {
        level: logLevel.DEBUG,
        stdLog: (...args) => {
            console.log('[GATEWAY LOG]', ...args);
        },
        errorLog: (...args) => {
            console.error('[GATEWAY ERROR]', ...args);
        }
    }


    //This is a sample authentication callback that will be processed prior to any connections being made. Excluding this and left unsecured is not advised. 
    const auth: preProcess = async ( options: {auth: any, type?: 'client'|'agent'}, callback: (error: any, room: string) => void ): Promise<void> => {
        try {
            if( options.auth && options.auth.optionalExtraAuthenticaitonToken){
                switch(options.type){
                    case 'client':{
                        //browser
                        //Do your authenticaiton and identification here. Simply pass the "room" the client will connect to. The agent will need to do its own authentication and indentification and then match this room
                        return callback(null, "my_custom_roomXYZ");
                        break;
                    }
                    case 'agent':{
                        //remote agent (machine you want to RD into)
                        //Do your authenticaiton and identification here. Simply pass the "room" the agent will connect to. The client will need to do its own authentication and indentification and then match this room
                        return callback(null, String(rmmClient.bbo_contnum));
                        break;
                    }
                }
            } 
        } catch (err) {
            console.error(err);
            return callback(err, '');
        }

        console.error('Invalid Login Attempt');
        return callback(new Error('Invalid Login Attempt'), '');
    }

    const socketIOGateway: SocketIOGatewayServer = new SocketIOGatewayServer(server, log_options, auth);

    socketIOGateway.on('open', (clientConnection) => { console.log('OPEN', clientConnection) });
    socketIOGateway.on('close', (clientConnection) => { console.log('CLOSE', clientConnection) });
    socketIOGateway.on('error', (clientConnection, error) => { console.error(clientConnection, error) });

    server.listen(listen_port, () => {
        console.log('Guacamole Gateway Server - online and listening on port: ' + listen_port);
    });

```



### Log levels

**clientOptions.log.level** defines verbosity of logs. Possible values are:
- *"QUIET"* - no logs
- *"ERRORS"* - only errors
- *"NORMAL"* - errors + minimal logs (startup and shutdown messages)
- *"VERBOSE"*  - (**default**) normal + connection messages (opened, closed, guacd exchange, etc)
- *"DEBUG"* - verbose + all OPCODES sent/received within guacamole sessions


### Custom log functions

By default *guacamole-gateway-ts* uses `console.log` and `console.error` functions for logging.
You can redefine these functions by setting **clientOptions.log.stdLog**
and **clientOptions.log.errorLog** like in the example below. Note that **clientOptions.log.level**
is still applied, which means that messages that don't match desired log level won't be
sent to your custom functions  

```typescript

const clientOptions = {
    log: {
        level: 'DEBUG',
        stdLog: (...args) => {
            console.log('[MyLog]', ...args)
        },
        errorLog: (...args) => {
            console.error('[MyLog]', ...args)
        }
    }
};

```


 ## Associated Components

 [guacamole-gateway-client](https://www.npmjs.com/package/guacamole-gateway-client)

 [Apache Guacamole](https://guacamole.apache.org/)
 