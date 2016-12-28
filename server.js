'use strict';

const glob = require('glob');

/**
 * Discovery Service is Responsible for pushing changes to
 * ServiceDescriptor(s) (i.e. route tables) to interested parties.
 *
 * Discovery Service also provides a Rest API to request said ServiceDescriptor(s) on demand.
 */
const main = () => {
  const config = require('config');
  const sha1 = require('sha1');
  const debug = require('debug')('discovery-service');
  const model = require('discovery-model').model;
  const Health = require('./libs/health.js');
  const HEALTH_CHECK_INTERVAL = 5000;
  const RESPONSE_TIME_METRIC_KEY = "response_time";

  console.log(`Starting Discovery Service on ${config.port}`);
  let app = require('express')();
  let http = require('http').Server(app);
  let io = require('socket.io')(http);

  /*
   * Clients interested in discovery
   * Here we want to map the query to an array of clients performing
   * said query.  When the query 'fires' a change event we will emit the
   * data to all subscribers that are interested.
   * {
   *   SHA("{\"type\": \"FooService\"}"): [<client>, ...]
   * }
   */
  let subscribers = {};
  let feeds = {};

  setInterval(() => {
    console.log('health check');
    model.allServices().then((services) => {
      services.forEach((service) => {
        let health = new Health();
        health.check(service).then((response) => {
          console.log(response);
        }).catch((err) => {
          console.log(err);
        });
      });
    });
  }, HEALTH_CHECK_INTERVAL);

  /* Http Routes */
  glob("./api/v1/routes/*.routes.js", {}, (err, files) => {
    files.forEach((file) => {
      console.log(file);
      require(file)(app);
    });
  });

  http.listen(config.port, () => {
    console.log(`listening on *:${config.port}`);
  });

  io.on('connection', (socket) => {
    console.log("Got connection..");

    socket.on('services:init', (msg) => {
      debug(msg);
      let query = msg;
      model.findServicesByTypes(query.types).then((services) => {
        console.log(services);
        services.forEach((service) => {
          debug(service);
          console.log(service);
          socket.emit('service.init', service);
        });
      });
    });

    socket.on('services:metrics', (msg) => {
      debug(msg);
      // Store Metrics (i.e. response_time) and associate with service
      let metric = msg;
      let serviceId = msg._id;
      if(metric.type === RESPONSE_TIME_METRIC_KEY) {
        // append response_time to service.rtimes
        model.findServiceById(serviceId).then((service) => {
          if(service.rtimes) {
            if(service.rtimes.length > 0 && service.rtimes.length < 10){
              service.rtimes.splice(0, 1);
              service.rtimes.push(value);
            } else {
              service.rtimes.push(value);
            }
          }
        }).error((err) => {
          console.log("Failed to find related service...");
          console.log(err);
        });
      }
    });

    socket.on('services:subscribe', (msg) => {
      debug(msg);
      let query = msg;
      let key = sha1(JSON.stringify(query));

      /**
        * Handle disconnect event.  In this situation we need to clean up
        * the client connections / subscriptions and close all feeds that
        * are no longer needed.
        */
      socket.on('disconnect', (event) => {
        debug('Disconnect Event');
        debug(event);
        subscribers[key].splice(socket);

        /** Clean it up 'bish' **/
        if(subscribers[key].length === 0) {
          //feeds[key].closeFeed();
          delete feeds[key];
          delete subscribers[key];
        }
      });

      /**
        * Bundle all connected clients based on interested query 'sha'
        * Also, keep track of the feed by query 'sha' such that the feed can
        * be closed when it's usefullness ceases to exist
        **/
      if(subscribers[key]) {
        subscribers[key].push(socket);
      } else {
        subscribers[key] = [socket];
        feeds[key] = [];
        /* Start Query --
         * Need some handle on this so we can kill the query when all interested parties disconnect
         */
        model.onServiceChange([query.types], (err, change) => {
          let keys = Object.keys(subscribers);
          keys.forEach((key) => {
            let clients = subscribers[key];
            // Falsey check
            if(!feeds[key]) {
              feeds[key] = change.record;
            }
            clients.forEach((client) => {
              client.emit('service.added', change.change);
              client.emit('service.removed', change.change);
              client.emit('service.updated', change.change);
            });
          });
        });
      }
    });
  });
}

/* Method main - Ha */
if(require.main === module) {
  main();
}

module.exports.client = require('./libs/client');
