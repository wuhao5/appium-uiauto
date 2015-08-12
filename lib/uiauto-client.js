// The Command Proxy relays UIAuto message to and from Appium. It is also the
// UIAuto facade for Appium.
//
// The message route is the following:
// Appium <--> Command Proxy <--> Instruments
// The medium between Instruments and Command Proxy is the command-proxy-client
// script.
//
// Command Proxy --> Instruments message format: {cmd:"<CMD>"}
//
// Instruments --> Command Proxy message format:
// <one char message type>,<stringified json data>
// <stringified json data> format:
// {status:<status>, value:<result>}

import UIAutoResponse from './uiauto-response';
import log from './logger';
import through from 'through';
import net from 'net';
import _mkdirp from 'mkdirp';
import { rimraf } from 'appium-support';
import path from 'path';
import Promise from 'bluebird';
import _ from 'lodash';

let mkdirp = Promise.promisify(_mkdirp);


const MORE_COMMAND = '#more';


class UIAutoClient {
  constructor (sock = '/tmp/instruments_sock') {
    this.curCommand = null;
    this.onReceiveCommand = null;
    this.commandQueue = [];
    this.sock = sock;
    this.socketServer = null;
    this.hasConnected = false;
    this.currentSocket = null;
  }

  async sendCommand (cmd) {
    return new Promise((resolve, reject) => {
      let cb = (result) => {
        // get back a JSONWP object, so decode and
        // just return the value
        if (result.status === 0) {
          resolve(result.value);
        } else {
          reject(new Error(result.value));
        }
      };
      this.commandQueue.push({cmd, cb});
      if (_.isFunction(this.onReceiveCommand)) {
        this.onReceiveCommand();
      }
    });
  }

  /*
   * Returns true if the resulting connecting is the first
   * socket connection for this proxy session
   */
  async start () {
    // only resolve the promise when the server that is created actually connects
    return new Promise(async (resolve) => {
      let response = new UIAutoResponse();
      this.socketServer = net.createServer({allowHalfOpen: true}, async (conn) => {
        if (!this.hasConnected) {
          this.hasConnected = true;
          log.info('Instruments is ready to receive commands');
          resolve(true);
        }
        // up with strings! down with buffers!
        conn.setEncoding('utf8');

        // keep track of this so that we can destroy the socket
        // when shutting down
        this.currentSocket = conn;

        conn.on('close', () => {
          this.currentSocket = null;
        });

        // all data goes into buffer
        conn.pipe(through((data) => {
          log.debug(`Socket data received (${data.length} bytes)`);
          response.addData(data);
        }));

        // when all data is in, deal with it
        conn.on('end', () => {
          // if we are midway through handling a command
          // we want to try out the data, getting more if necessary
          if (this.curCommand) {
            let result = response.getResult();
            if (result.needsMoreData) {
              log.debug('Not the last chunk, trying to get more');
              // add a command to the queue, to request more data
              this.commandQueue.unshift({cmd: MORE_COMMAND, cb: this.curCommand.cb});
            } else {
              // if we're done altogether, call the callback associated with the command
              this.curCommand.cb(result);
              this.curCommand = null;
            }
          } else {
            log.debug('Got a result when we were not expecting one! Ignoring it');
            response.resetBuffer();
          }

          // set up a callback to handle the next command
          let onReceiveCommand = () => {
            this.onReceiveCommand = null;
            this.curCommand = this.commandQueue.shift();
            log.debug(`Sending command to instruments: ${this.curCommand.cmd}`);
            conn.write(JSON.stringify({cmd: this.curCommand.cmd}));
            conn.end();
          };
          if (this.commandQueue.length) {
            onReceiveCommand();
          } else {
            this.onReceiveCommand = onReceiveCommand;
          }
        });
      });

      this.socketServer.on('close', function () {
        log.debug('Instruments socket server was closed');
      });

      // remove socket file if it currently exists
      await rimraf(this.sock);

      // create the new socket file
      await mkdirp(path.dirname(this.sock));

      this.socketServer.listen(this.sock);
      log.debug(`Instruments socket server started at ${this.sock}`);
    });
  }

  async shutdown () {
    // make sure clear out command cbs so we can't have any lingering cbs
    // if a socket request makes it through after exit somehow
    this.curCommand = null;
    this.onReceiveCommand = null;

    if (this.currentSocket) {
      log.debug('Destroying instruments client socket.');
      this.currentSocket.end();
      this.currentSocket.destroy();
      this.currentSocket = null;
    }
    if (this.socketServer) {
      log.debug('Closing socket server.');
      await (Promise.promisify(this.socketServer.close, this.socketServer))();
      this.socketServer = null;
    }
  }

  async safeShutdown () {
    log.debug('Shutting down command proxy and ignoring any errors');
    try {
      await this.shutdown();
    } catch (err) {
      log.debug(`Ignoring error: ${err}`);
    }
  }
}

export default UIAutoClient;