
/**
 * Module dependencies.
 */

var uid2 = require('uid2');
var redis = require('redis').createClient;
var msgpack = require('msgpack-js');
var Adapter = require('socket.io-adapter');
var Emitter = require('events').EventEmitter;
var debug = require('debug')('socket.io-redis');
var async = require('async');

/**
 * Module exports.
 */

module.exports = adapter;

/**
 * Returns a redis Adapter class.
 *
 * @param {String} optional, redis uri
 * @return {RedisAdapter} adapter
 * @api public
 */

function adapter(uri, opts){
  opts = opts || {};

  // handle options only
  if ('object' == typeof uri) {
    opts = uri;
    uri = null;
  }

  // opts
  var pub = opts.pubClient;
  var sub = opts.subClient;
  var syncSub = opts.syncClient;

  var prefix = opts.key || 'socket.io';
  var subEvent = opts.subEvent || 'message';

  // init clients if needed
  function createClient(redis_opts) {
    if (uri) {
      // handle uri string
      return redis(uri, redis_opts);
    } else {
      return redis(opts.port, opts.host, redis_opts);
    }
  }
  
  if (!pub) pub = createClient();
  if (!sub) sub = createClient({ return_buffers: true });
  if (!syncSub) syncSub = createClient();

  var syncPub = syncSub.duplicate();

  // this server's key
  var uid = uid2(6);

  /**
   * Adapter constructor.
   *
   * @param {String} namespace name
   * @api public
   */

  function Redis(nsp){
    Adapter.call(this, nsp);

    this.uid = uid;
    this.prefix = prefix;

    this.channel = prefix + '#' + nsp.name + '#';
    this.syncChannel = prefix + '-sync#request';

    if (String.prototype.startsWith) {
      this.channelMatches = function (messageChannel, subscribedChannel) {
        return messageChannel.startsWith(subscribedChannel);
      }
    } else { // Fallback to other impl for older Node.js
      this.channelMatches = function (messageChannel, subscribedChannel) {
        return messageChannel.substr(0, subscribedChannel.length) === subscribedChannel;
      }
    }
    this.pubClient = pub;
    this.subClient = sub;

    var self = this;

    sub.subscribe(this.channel, function(err){
      if (err) self.emit('error', err);
    });

    syncSub.subscribe(this.syncChannel, function(err){
      if (err) self.emit('error', err);
    });

    sub.on(subEvent, this.onmessage.bind(this));
    syncSub.on(subEvent, this.onclients.bind(this));
  }

  /**
   * Inherits from `Adapter`.
   */

  Redis.prototype.__proto__ = Adapter.prototype;

  /**
   * Called with a subscription message
   *
   * @api private
   */

  Redis.prototype.onmessage = function(channel, msg){
    if (!this.channelMatches(channel.toString(), this.channel)) {
      return debug('ignore different channel');
    }
    var args = msgpack.decode(msg);
    var packet;

    if (uid == args.shift()) return debug('ignore same uid');

    packet = args[0];

    if (packet && packet.nsp === undefined) {
      packet.nsp = '/';
    }

    if (!packet || packet.nsp != this.nsp.name) {
      return debug('ignore different namespace');
    }

    args.push(true);

    this.broadcast.apply(this, args);
  };

  /**
   * Called with a subscription message on sync
   *
   * @api private
   */

  Redis.prototype.onclients = function(channel, msg){
    try {
      var decoded = JSON.parse(msg);
    } catch(err){
      self.emit('error', err);
      return;
    }

    Adapter.prototype.clients.call(this, decoded.rooms, function(err, clients){
      if(err){
        self.emit('error', err);
        return;
      }

      var responseChn = prefix + '-sync#response#' + decoded.transaction;
      var response = JSON.stringify({
        clients : clients
      });

      syncPub.publish(responseChn, response);
    });
    
  };

  /**
   * Broadcasts a packet.
   *
   * @param {Object} packet to emit
   * @param {Object} options
   * @param {Boolean} whether the packet came from another node
   * @api public
   */

  Redis.prototype.broadcast = function(packet, opts, remote){
    Adapter.prototype.broadcast.call(this, packet, opts);
    if (!remote) {
      var chn = prefix + '#' + packet.nsp + '#';
      var msg = msgpack.encode([uid, packet, opts]);
      if (opts.rooms) {
        opts.rooms.forEach(function(room) {
          var chnRoom = chn + room + '#';
          pub.publish(chnRoom, msg);
        });
      } else {
        pub.publish(chn, msg);
      }
    }
  };

  /**
   * Subscribe client to room messages.
   *
   * @param {String} client id
   * @param {String} room
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.add = function(id, room, fn){
    debug('adding %s to %s ', id, room);
    var self = this;
    Adapter.prototype.add.call(this, id, room);
    var channel = prefix + '#' + this.nsp.name + '#' + room + '#';
    sub.subscribe(channel, function(err){
      if (err) {
        self.emit('error', err);
        if (fn) fn(err);
        return;
      }
      if (fn) fn(null);
    });
  };

  /**
   * Unsubscribe client from room messages.
   *
   * @param {String} session id
   * @param {String} room id
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.del = function(id, room, fn){
    debug('removing %s from %s', id, room);

    var self = this;
    var hasRoom = this.rooms.hasOwnProperty(room);
    Adapter.prototype.del.call(this, id, room);

    if (hasRoom && !this.rooms[room]) {
      var channel = prefix + '#' + this.nsp.name + '#' + room + '#';
      sub.unsubscribe(channel, function(err){
        if (err) {
          self.emit('error', err);
          if (fn) fn(err);
          return;
        }
        if (fn) fn(null);
      });
    } else {
      if (fn) process.nextTick(fn.bind(null, null));
    }
  };

  /**
   * Unsubscribe client completely.
   *
   * @param {String} client id
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.delAll = function(id, fn){
    debug('removing %s from all rooms', id);

    var self = this;
    var rooms = this.sids[id];

    if (!rooms) {
      if (fn) process.nextTick(fn.bind(null, null));
      return;
    }

    async.forEach(Object.keys(rooms), function(room, next){
      self.del(id, room, next);
    }, function(err){
      if (err) {
        self.emit('error', err);
        if (fn) fn(err);
        return;
      }
      delete self.sids[id];
      if (fn) fn(null);
    });
  };

  /**
   * Gets a list of clients by sid.
   *
   * @param {Array} explicit set of rooms to check.
   * @api public
   */

  Redis.prototype.clients = function(rooms, fn){
    if ('function' == typeof rooms){
      fn = rooms;
      rooms = null;
    }

    rooms = rooms || [];

    var self = this;

    var transaction = uid2(6);
    var responseChn = prefix + '-sync#response#' + transaction;

    var clientsSub = syncPub.duplicate();
    syncPub.send_command('pubsub', ['numsub', self.syncChannel], function(err, numsub){
      if (err) {
        self.emit('error', err);
        if (fn) fn(err);
        return;
      }

      numsub = numsub[1];

      var msg_count = 0;
      var clients = [];

      clientsSub.on("subscribe", function (channel, count) {

        var request = JSON.stringify({
          transaction : transaction,
          rooms : rooms
        });

        /*If there is no response for 5 seconds, return result;*/
        var timeout = setTimeout(function() {
          console.warn('Too many subscribers on the sync channel');
          if (fn) process.nextTick(fn.bind(null, null, clients));
        }, 5000);

        clientsSub.on(subEvent, function (channel, msg) {
          var response = JSON.parse(msg);
          clients = clients.concat(response.clients);
          msg_count++;
          if(msg_count == numsub){
            clearTimeout(timeout);
            clientsSub.unsubscribe();
            clientsSub.quit();
            if (fn) process.nextTick(fn.bind(null, null, clients));
          }
        });

        syncPub.publish(self.syncChannel, request);

      });

      clientsSub.subscribe(responseChn);

    });

  };

  Redis.uid = uid;
  Redis.pubClient = pub;
  Redis.subClient = sub;
  Redis.prefix = prefix;

  return Redis;

}
