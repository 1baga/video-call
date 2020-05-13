const config = require('./config');
const debugModule = require('debug');
const mediasoup = require('mediasoup');
const express = require('express');
const https = require('https');
const fs = require('fs');
const socketIO = require('socket.io');

let expressApp, httpsServer, socketServer, worker, router, audioLevelObserver;

const log = debugModule('demo-app');
const warn = debugModule('demo-app:WARN');
const err = debugModule('demo-app:ERROR');

// one mediasoup worker and router

const roomState = {
  // external
  peers: {},
  activeSpeaker: { producerId: null, volume: null, peerId: null },
  // internal
  transports: {},
  producers: [],
  consumers: [],
};

(async () => {
  try {
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
    await startMediasoup();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const tls = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  httpsServer = https.createServer(tls, expressApp);
  httpsServer.on('error', err => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise(resolve => {
    const { httpIp, httpPort } = config;
    httpsServer.listen(httpPort, httpIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log('server is running');
      console.log(`open https://${ip}:${httpPort} in your web browser`);
      resolve();
    });
  });

  // periodically clean up peers that disconnected without sending us
  // a final "beacon"
  setInterval(() => {
    let now = Date.now();
    Object.entries(roomState.peers).forEach(([id, p]) => {
      if (now - p.lastSeenTs > config.httpPeerStale) {
        warn(`removing stale peer ${id}`);
        closePeer(id);
      }
    });
  }, 1000);

  // periodically update video stats we're sending to peers
  setInterval(updatePeerStats, 3000);
}

async function runSocketServer() {
  socketServer = socketIO(httpsServer, {
    serveClient: false,
    path: '/sock',
    log: true,
  });

  socketServer.on('connection', socket => {
    console.log('client connected');

    socket.on('disconnect', () => {
      console.log('client disconnected');
    });

    socket.on('connect_error', err => {
      console.error('client connection error', err);
    });

    // After connection this is the first socket call that would be made
    socket.on('getRouterRtpCapabilities', (data, callback) => {
      let { peerId } = data,
        now = Date.now();
      log('new-peer', peerId);

      roomState.peers[peerId] = {
        joinTs: now,
        lastSeenTs: now,
        media: {},
        consumerLayers: {},
        stats: {},
      };

      callback(router.rtpCapabilities);
    });

    // Handles create transport request
    socket.on('createTransport', async (data, callback) => {
      try {
        let { peerId, direction } = data;
        console.log('create-transport', peerId, direction);

        let transport = await createWebRtcTransport({
          peerId,
          direction,
        });
        roomState.transports[transport.id] = transport;

        let { id, iceParameters, iceCandidates, dtlsParameters } = transport;

        callback({
          transportOptions: { id, iceParameters, iceCandidates, dtlsParameters },
        });
      } catch (e) {
        console.error('error in createTransport', e);
        callback({ error: e });
      }
    });

    // Connect/Open the transport
    socket.on('connectTransport', async (data, callback) => {
      try {
        let { peerId, transportId, dtlsParameters } = data,
          transport = roomState.transports[transportId];

        if (!transport) {
          throw new Error(`connect-transport: server-side transport ${transportId} not found`);
        }

        console.log('connect-transport', peerId, transport.appData);

        await transport.connect({ dtlsParameters });
        callback({ connected: true });
      } catch (e) {
        console.error('error in connectTransport', e);
        callback({ error: e });
      }
    });

    // To close a transport
    socket.on('closeTransport', async (data, callback) => {
      try {
        let { peerId, transportId } = data,
          transport = roomState.transports[transportId];

        if (!transport) {
          throw new Error(`close-transport: server-side transport ${transportId} not found`);
        }

        log('close-transport', peerId, transport.appData);

        await closeTransport(transport);
        callback({ closed: true });
      } catch (e) {
        console.error('error in closeTransport', e);
        callback({ error: e.message });
      }
    });

    // This will be used to stop sending a specific track, e.g Audio Track, Video Track e.t.c
    socket.on('closeProducer', async (data, callback) => {
      try {
        let { peerId, producerId } = data,
          producer = roomState.producers.find(p => p.id === producerId);

        if (!producer) {
          throw new Error(`close-producer: server-side producer ${producerId} not found`);
        }

        log('close-producer', peerId, producer.appData);

        await closeProducer(producer);
        callback({ closed: true });
      } catch (err) {
        console.error('error in closeProducer', err);
        callback({ error: e.message });
      }
    });

    socket.on('pauseProducer', async (data, callback) => {
      try {
        let { peerId, producerId } = data,
          producer = roomState.producers.find(p => p.id === producerId);

        if (!producer) {
          throw new Error(`pause-producer: server-side producer ${producerId} not found`);
        }

        log('pause-producer', producer.appData);
        await producer.pause();
        roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;
        callback({ paused: true });
      } catch (e) {
        console.error('error in pause-producer', e);
        callback({ error: e });
      }
    });

    socket.on('resumeProducer', async (data, callback) => {
      try {
        let { peerId, producerId } = data,
          producer = roomState.producers.find(p => p.id === producerId);

        if (!producer) {
          throw new Error(`resume-producer: server-side producer ${producerId} not found`);
        }

        log('resume-producer', producer.appData);

        await producer.resume();

        roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;

        callback({ resumed: true });
      } catch (e) {
        console.error('error in resume-producer', e);
        callback({ error: e });
      }
    });

    // This is where we produce/send a track for other people to recieve
    // This will create a new mediasoup producer object
    socket.on('sendTrack', async (data, callback) => {
      try {
        let { peerId, transportId, kind, rtpParameters, paused = false, appData } = data,
          transport = roomState.transports[transportId];

        if (!transport) {
          throw new Error(`send-track: server-side transport ${transportId} not found`);
        }

        let producer = await transport.produce({
          kind,
          rtpParameters,
          paused,
          appData: { ...appData, peerId, transportId },
        });

        // if our associated transport closes, close ourself, too
        producer.on('transportclose', () => {
          log("producer's transport closed", producer.id);
          closeProducer(producer);
        });

        // monitor audio level of this producer. we call addProducer() here,
        // but we don't ever need to call removeProducer() because the core
        // AudioLevelObserver code automatically removes closed producers
        if (producer.kind === 'audio') {
          audioLevelObserver.addProducer({ producerId: producer.id });
        }

        roomState.producers.push(producer);
        roomState.peers[peerId].media[appData.mediaTag] = {
          paused,
          encodings: rtpParameters.encodings,
        };

        // socket.broadcast.emit('newProducer');

        callback({ id: producer.id });
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    // create a mediasoup consumer object, hook it up to a producer here
    // on the server side, and send back info needed to create a consumer
    // object on the client side. always start consumers paused. client
    // will request media to resume when the connection completes
    socket.on('receiveTrack', async (data, callback) => {
      try {
        let { peerId, mediaPeerId, mediaTag, rtpCapabilities } = data;

        let producer = roomState.producers.find(
          p => p.appData.mediaTag === mediaTag && p.appData.peerId === mediaPeerId
        );

        // Check if producer exists
        if (!producer) {
          let msg = 'server-side producer for ' + `${mediaPeerId}:${mediaTag} not found`;
          throw new Error('recvTrack: ' + msg);
        }

        // Check if the producer can consume/receive this track
        if (
          !router.canConsume({
            producerId: producer.id,
            rtpCapabilities,
          })
        ) {
          let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`;
          throw new Error(`recvTrack: ${peerId} ${msg}`);
        }

        let transport = Object.values(roomState.transports).find(
          t => t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
        );

        if (!transport) {
          let msg = `server-side recv transport for ${peerId} not found`;
          throw new Error('recvTrack: ' + msg);
        }

        let consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true, // see note above about always starting paused
          appData: { peerId, mediaPeerId, mediaTag },
        });

        // need both 'transportclose' and 'producerclose' event handlers,
        // to make sure we close and clean up consumers in all
        // circumstances
        consumer.on('transportclose', () => {
          log(`consumer's transport closed`, consumer.id);
          closeConsumer(consumer);
        });
        consumer.on('producerclose', () => {
          log(`consumer's producer closed`, consumer.id);
          closeConsumer(consumer);
        });

        // stick this consumer in our list of consumers to keep track of,
        // and create a data structure to track the client-relevant state
        // of this consumer
        roomState.consumers.push(consumer);
        roomState.peers[peerId].consumerLayers[consumer.id] = {
          currentLayer: null,
          clientSelectedLayer: null,
        };

        // update above data structure when layer changes.
        consumer.on('layerschange', layers => {
          log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers);
          if (roomState.peers[peerId] && roomState.peers[peerId].consumerLayers[consumer.id]) {
            roomState.peers[peerId].consumerLayers[consumer.id].currentLayer = layers && layers.spatialLayer;
          }
        });

        callback({
          producerId: producer.id,
          id: consumer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type: consumer.type,
          producerPaused: consumer.producerPaused,
        });
      } catch (err) {
        console.error('error in /signaling/recv-track', err);
        callback({ error: err });
      }
    });

    // You will call this guy if you want to pause receiving a track from another peer
    socket.on('pauseConsumer', async (data, callback) => {
      try {
        let { peerId, consumerId } = data,
          consumer = roomState.consumers.find(c => c.id === consumerId);

        if (!consumer) {
          throw new Error(`pause-consumer: server-side consumer ${consumerId} not found`);
        }

        log('pause-consumer', consumer.appData);

        await consumer.pause();

        callback({ paused: true });
      } catch (err) {
        console.error('error in pause-consumer', err);
        callback({ error: err });
      }
    });

    socket.on('resumeConsumer', async (data, callback) => {
      try {
        let { peerId, consumerId } = data,
          consumer = roomState.consumers.find(c => c.id === consumerId);

        if (!consumer) {
          throw new Error(`pause-consumer: server-side consumer ${consumerId} not found`);
        }

        log('resume-consumer', consumer.appData);

        await consumer.resume();

        callback({ resumed: true });
      } catch (err) {
        console.error('error in resume-consumer', err);
        callback({ error: err });
      }
    });

    socket.on('closeConsumer', async (data, callback) => {
      try {
        let { peerId, consumerId } = data,
          consumer = roomState.consumers.find(c => c.id === consumerId);

        console.log('INCOMING CONSUMER ID:: ', consumerId);
        console.log(
          'CONSUMERS::: ',
          roomState.consumers.map(item => item.id)
        );

        if (!consumer) {
          throw new Error(`close-consumer: server-side consumer ${consumerId} not found`);
        }

        await closeConsumer(consumer);

        callback({ closed: true });
      } catch (err) {
        console.error('error in close-consumer', err);
        callback({ error: err });
      }
    });

    socket.on('setConsumerLayer', async (data, callback) => {
      try {
        let { peerId, consumerId, spatialLayer } = data,
          consumer = roomState.consumers.find(c => c.id === consumerId);

        if (!consumer) {
          throw new Error(`consumer-set-layers: server-side consumer ${consumerId} not found`);
        }

        log('consumer-set-layers', spatialLayer, consumer.appData);

        await consumer.setPreferredLayers({ spatialLayer });

        callback({ layersSet: true });
      } catch (err) {
        console.error('error in set-consumer-layer', err);
        callback({ error: err });
      }
    });
    // This is a sync call, every connected client will call this guy every 1 second
    socket.on('sync', async (peerId, callback) => {
      try {
        if (!roomState.peers[peerId]) {
          throw new Error('not connected');
        }
        // update our most-recently-seem timestamp -- we're not stale!
        roomState.peers[peerId].lastSeenTs = Date.now();

        callback({
          peers: roomState.peers,
          activeSpeaker: roomState.activeSpeaker,
        });
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('leave', async (data, callback) => {
      try {
        let { peerId } = data;
        log('leave', peerId);

        await closePeer(peerId);
        callback({ left: true });
      } catch (e) {
        console.error('error in leave', e);
        callback({ error: e });
      }
    });
  });
}

async function startMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died (this should never happen)');
    process.exit(1);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  router = await worker.createRouter({ mediaCodecs });

  // audioLevelObserver for signaling active speaker
  //
  audioLevelObserver = await router.createAudioLevelObserver({
    interval: 800,
  });

  audioLevelObserver.on('volumes', volumes => {
    const { producer, volume } = volumes[0];
    log('audio-level volumes event', producer.appData.peerId, volume);
    roomState.activeSpeaker.producerId = producer.id;
    roomState.activeSpeaker.volume = volume;
    roomState.activeSpeaker.peerId = producer.appData.peerId;
  });

  audioLevelObserver.on('silence', () => {
    log('audio-level silence event');
    roomState.activeSpeaker.producerId = null;
    roomState.activeSpeaker.volume = null;
    roomState.activeSpeaker.peerId = null;
  });
}

// FUnction that handles creating of webrtc transport
async function createWebRtcTransport({ peerId, direction }) {
  const { listenIps, initialAvailableOutgoingBitrate } = config.mediasoup.webRtcTransport;

  const transport = await router.createWebRtcTransport({
    listenIps: listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
    appData: { peerId, clientDirection: direction },
  });

  return transport;
}

async function closeTransport(transport) {
  try {
    log('closing transport', transport.id, transport.appData);

    // our producer and consumer event handlers will take care of
    // calling closeProducer() and closeConsumer() on all the producers
    // and consumers associated with this transport
    await transport.close();

    // so all we need to do, after we call transport.close(), is update
    // our roomState data structure
    delete roomState.transports[transport.id];
  } catch (e) {
    err(e);
  }
}

function closePeer(peerId) {
  log('closing peer', peerId);
  for (let [id, transport] of Object.entries(roomState.transports)) {
    if (transport.appData.peerId === peerId) {
      closeTransport(transport);
    }
  }
  delete roomState.peers[peerId];
}

async function closeProducer(producer) {
  log('closing producer', producer.id, producer.appData);
  try {
    await producer.close();

    // remove this producer from our roomState.producers list
    roomState.producers = roomState.producers.filter(p => p.id !== producer.id);

    // remove this track's info from our roomState...mediaTag bookkeeping
    if (roomState.peers[producer.appData.peerId]) {
      delete roomState.peers[producer.appData.peerId].media[producer.appData.mediaTag];
    }
  } catch (e) {
    err(e);
  }
}

async function closeConsumer(consumer) {
  log('closing consumer', consumer.id, consumer.appData);
  await consumer.close();

  // remove this consumer from our roomState.consumers list
  roomState.consumers = roomState.consumers.filter(c => c.id !== consumer.id);

  // remove layer info from from our roomState...consumerLayers bookkeeping
  if (roomState.peers[consumer.appData.peerId]) {
    delete roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id];
  }
}

async function updatePeerStats() {
  for (let producer of roomState.producers) {
    if (producer.kind !== 'video') {
      continue;
    }
    try {
      let stats = await producer.getStats(),
        peerId = producer.appData.peerId;
      roomState.peers[peerId].stats[producer.id] = stats.map(s => ({
        bitrate: s.bitrate,
        fractionLost: s.fractionLost,
        jitter: s.jitter,
        score: s.score,
        rid: s.rid,
      }));
    } catch (e) {
      warn('error while updating producer stats', e);
    }
  }

  for (let consumer of roomState.consumers) {
    try {
      let stats = (await consumer.getStats()).find(s => s.type === 'outbound-rtp'),
        peerId = consumer.appData.peerId;
      if (!stats || !roomState.peers[peerId]) {
        continue;
      }
      roomState.peers[peerId].stats[consumer.id] = {
        bitrate: stats.bitrate,
        fractionLost: stats.fractionLost,
        score: stats.score,
      };
    } catch (e) {
      warn('error while updating consumer stats', e);
    }
  }
}
