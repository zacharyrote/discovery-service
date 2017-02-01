'use strict';

const debug = require('debug')('discovery-service-lifecycle');
const config = require('config');
const async = require('async');
const sha1 = require('sha1');
const startup = require('./startup');
const Promise = require('promise');
const RESPONSE_TIME_METRIC_KEY = "response_time";
const REFRESH_EVENT = "refresh_event";

const EventEmitter = require('events').EventEmitter;

/**
 * ServiceLifecycle - Discovery Server
 *
 * 1. Websocket client connect
 * 2. Authorization Request From Client
 * 3. Init ( Ask for ServiceDescriptor(s) that are of interest )
 * 4. Subscribe ( Ask to be notified of changes to ServiceDescriptor(s) of interest)
 * 5. Notify Discovery of Service deemed to be 'Online'
 * 6. Notify Discovery of Service deemed to be 'Offline'
 * 7. Websocket disconnect => Clean up Subscription if exists.
 */
class ServiceLifecycle extends EventEmitter {
  constructor(io, ioredis, repo) {
    super();
    this.model = repo;
    this.io = io;
    this.ioredis = ioredis;

    // Clustered Socket IO using Redis -- Move out of lifecycle
    // io.adapter(ioredis({
    //   host: 'localhost',
    //   port: 6379
    // }));

    // Authorization of Client Connection -- Move out of lifecycle
    // authSetup(io, {
    //   authenticate: (socket, data, callback) => {
    //       callback(null, true);
    //   }
    // });

    /*
     * Clients interested in discovery
     * Here we want to map the query to an array of clients performing
     * said query.  When the query 'fires' a change event we will emit the
     * data to all subscribers that are interested.
     * {
     *   SHA("{\"type\": \"FooService\"}"): [<client>, ...]
     * }
     */
    this.subscribers = {};
    this.feeds = {};
    this.queries = {};

    setInterval(() => {
      debug(Object.keys(this.feeds));
    }, 30000);
  }

  /**
   * Get Me
   * Essentially construct an announcement of the
   * existence of the DiscoveryService.
   */
  getMe(id, announce) {
    let descriptor = {
      type: 'DiscoveryService',
      healthCheckRoute: '/health',
      schemaRoute: '/swagger.json',
      docsPath: announce.docsPath,
      timestamp: new Date(),
      id: id,
      region: announce.region,
      stage: announce.stage,
      status: 'Online',
      version: announce.version
    };

    let p = new Promise((resolve, reject) => {
      let ip = require('ip');
      debug(`IP is ${ip.address()}`);
      descriptor.endpoint = "http://"+ip.address()+":"+config.port
      resolve(descriptor);
    });
    return p;
  }

  authenticate() {

  }

  _addSubscriber(key, socket) {
    if(this.subscribers[key].indexOf(socket.id) == -1)
      this.subscribers[key].push(socket.id);
  }

  _createAndAddToSubscriberQueue(key, socket) {
    this.subscribers[key] = [socket.id];
  }

  _removeSubscriber(key) {
    delete this.feeds[key];
    delete this.subscribers[key];
  }

  handleSubscribe(subscribeMessage, socket) {
    debug(subscribeMessage);
    let query = subscribeMessage;
    let key = sha1(JSON.stringify(query));

    /**
      * Handle disconnect event.  In this situation we need to clean up
      * the client connections / subscriptions and close all feeds that
      * are no longer needed.
      */
    socket.on('disconnect', (event) => {
      debug('Disconnect Event');
      debug(event);
      debug(key);
      if(this.subscribers[key]) {
        debug(`Socket id ${socket.id}`);
        debug(`Before ${this.subscribers[key]}`);
        let spliced = this.subscribers[key].splice(this.subscribers[key].indexOf(socket.id), 1);
        debug(`After ${this.subscribers[key]}`);
        /** Clean it up 'bish' **/
        if(this.subscribers[key].length === 0) {
          // console.log(feeds[key]);
          //this.feeds[key].close();
          //this.feeds[key]._model.removeAllListeners();

          this._removeSubscriber(key);
          this.emit('subscriber.change', this.subscribers);
          this.emit('feed.change', this.feeds);
        }
      } else {
        debug("WARN - MISSING KEY ....... FEED DELETE FAILED");
      }

      if(socket.service_id) {
        debug(`Deleting Service ${socket.service_id}`);
        this.model.deleteService(socket.service_id).then((result) => {
          debug(`Deleted Service ${socket.service_id}`);
          socket.broadcast.emit(REFRESH_EVENT, { serviceId: socket.service_id });
        }).error((err) => {
          console.log(err);
        });
      } else {
        console.log(`Socket missing services id`);
      }

    }); // close on-disconnect

    if(query.types && query.types.length > 0) {
      this.queries[key] = query;
      this.emit('query.change', this.queries);
      /**
        * Bundle all connected clients based on interested query 'sha'
        * Also, keep track of the feed by query 'sha' such that the feed can
        * be closed when it's usefullness ceases to exist
        **/
      if(this.subscribers[key]) {
        this._addSubscriber(key, socket);
        this.emit('subscriber.change', this.subscribers);
      } else {
        this._createAndAddToSubscriberQueue(key, socket);
        this.feeds[key] = [];
        /* Start Query --
          * Need some handle on this so we can kill the query when all interested parties disconnect
          */
        let myFeed = this.model.onServiceChange(query.types, (err, change) => {
          //let keys = Object.keys(this.subscribers);
          let clients = this.subscribers[key];
          let clientCount = 0;
          if(clients) {
            clientCount = clients.length;
          }
          console.log(`............................Client Count ${clientCount}`);
          if(clients) {
            console.log(clients);
            clients.forEach((client) => {
              if(change.isNew === true) {
                this.emit('service.added', { feedKey: key, change: change.change });
                this.io.sockets.connected[client].emit('service.added', change.change);
              } else if(change.deleted === true) {
                this.emit('service.removed', { feedKey: key, change: change.change });
                this.io.sockets.connected[client].emit('service.removed', change.change);
              } else {
                this.emit('service.updated', { feedKey: key, change: change.change });
                this.io.sockets.connected[client].emit('service.updated', change.change);
              }
            });
          }
        });


        myFeed.query = query;
        this.feeds[key] = myFeed;
        this.emit('feed.change', this.feeds);
        this.emit('subscriber.change', this.subscribers);
      }
    }
  }

  /**
   * Handle Init
   * We run the announced descriptor through a validation pipeline to verify
   *  - 1. Health
   *  - 2. Swagger
   *  - 3. Docs Path
   * If any of these checks fail for the descriptor, the descriptor does not
   * make it into the registry.
   *
   * After handling the Announcement, We look up the Service Descriptor(s) the
   * announcing service is interested in.
   * These descriptors are sent back to the client via the `service.init` channel.
   */
  handleInit(initMessage, socket) {
    debug(initMessage);
    let query = initMessage;
    let descriptor = initMessage.descriptor;
    // Validate Descriptor and verify that the service is 'kosher'
    if(descriptor) {
      async.waterfall(
        startup.createValidationPipeline(descriptor),
        (err, results) => {
        if(err) {
          debug(err);
        } else {
          // Save Descriptor
          this.model.findServiceByEndpoint(descriptor.endpoint).then((service) => {
            if(service === null) {
              // Save.
              // find by endpoint -- if not there save else update
              this.model.saveService(descriptor).then((service) => {
                socket.service_id = service.id;
                debug(`Updated Service Descriptor in registry for ${service.id}`);
                socket.broadcast.emit(REFRESH_EVENT, { serviceId: service.id });
              }).error((err) => {
                debug('Error registering service');
                debug(err);
              });
            } else {
              // Update.
              descriptor.id = service.id;
              this.model.updateService(descriptor).then((updated) => {
                socket.service_id = updated.id;
                debug(`Updated Service Descriptor in registry for ${updated.id}`);
                socket.broadcast.emit(REFRESH_EVENT, { serviceId: updated.id});
              }).error((err) => {
                debug('Error registering service');
                debug(err);
              });
            }
          });

          // Find services by types..
          this.model.findServicesByTypes(query.types).then((services) => {
            services.elements.forEach((service) => {
              debug(service);
              socket.emit('service.init', service);
              this.emit('service.init', service);
            });
          });
        }
      });
    } else {
      // No Descriptor so just init the query types.
      // Find services by types..  This result is a pagedResponse.
      // Need to reconsider this approach.  I believe the default page size is 10..
      // Will be an issue when the number of services grows .
      this.model.findServicesByTypes(query.types).then((services) => {
        debug(services);
        services.elements.forEach((service) => {
          debug(service);
          socket.emit('service.init', service);
        });
      });
    }
  }

  /**
   * Handle Online
   * When a client detects that a service it uses is has come back up
   * the Discovery Service Lifecycle expects the client to notify
   * that the service is 'Online'
   */
  handleOnline(onlineMessage, socket) {
    debug(onlineMessage);
    let serviceId = onlineMessage.serviceId;
    model.findServiceById(serviceId).then((service) => {
      if(service) {
        service.status = this.model.STATUS_ONLINE;
        model.updateService(service).then((service) => {
          debug(`updated status of service ${service.id} to online`);
          socket.broadcast.emit(REFRESH_EVENT, { serviceId: socket.service_id });
        }).error((error) => {
          debug(error);
        });
      }
    }).error((error) => {
      debug(error);
    });
  }

  /**
   * Handle Offline
   * When a client detects that a service it uses is `not available` or returning
   * a 'bad gateway' the Discovery Service Lifecycle expects the client to notify
   * that the service is 'Offline'
   */
  handleOffline(offlineMessage, socket) {
    debug(offlineMessage);
    let serviceId = offlineMessage.serviceId;
    this.model.findServiceById(serviceId).then((service) => {
      if(service) {
        service.status = this.model.STATUS_OFFLINE;
        model.updateService(service).then((service) => {
          debug(`updated status of service ${service.id} to offline`);
          socket.broadcast.emit(REFRESH_EVENT, { serviceId: socket.service_id });
        }).error((error) => {
          debug(error);
        });
      }
    }).error((error) => {
      debug(error);
    });
  }

  /**
   * Handle Metrics
   * The Discovery Service Lifecycle allows for the discovery-proxy to report
   * metrics such as 'response time' after making a call to a dependent service.
   * These metrics are recorded and in the case of 'response time', a rolling avg
   * is computed.
   */
  handleMetrics(metric, socket) {
    let serviceId = metric.serviceId;
    let value = metric.value;
    if(metric.type === RESPONSE_TIME_METRIC_KEY) {
      // append response_time to service.rtimes
      this.model.findServiceById(serviceId).then((service) => {
        if(service.rtimes) {
          if(service.rtimes.length > 0 && service.rtimes.length < 10){
            service.rtimes.splice(0, 1);
            service.rtimes.push(value);
          } else {
            service.rtimes.push(value);
          }

          // Compute avg
          let total = 0;
          let avg = 0;
          for(let i in service.rtimes) {
            total += service.rtimes[i];
            avg = total/(service.rtimes.length);
          }

          service.avgTime = avg;

          model.updateService(service).then((updated) => {
            debug(`Updated service ${service.id}`);
          });
        }
      }).error((err) => {
        console.log("Failed to find related service...");
        console.log(err);
      });
    }
  }
}

// Public
module.exports = ServiceLifecycle;
