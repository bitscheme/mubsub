var EventEmitter = require('events').EventEmitter;
var util = require('util');

var noop = function () {};

/**
 * Channel constructor.
 *
 * @param {Connection} connection
 * @param {String} [name] optional channel/collection name, default is 'mubsub'
 * @param {Object} [options] optional options
 *   - `size` max size of the collection in bytes, default is 5mb
 *   - `max` max amount of documents in the collection
 *   - `retryInterval` time in ms to wait if no docs found, default is 200ms
 *   - `recreate` recreate the tailable cursor on error, default is true
 * @api public
 */
function Channel(connection, name, options = {}) {
    this.collectionOptions = {
        capped: true,
        // In mongo v <= 2.2 index for _id is not done by default
        //autoIndexId: true,
        size: options.size || 1024 * 1024 * 5,
        strict: false,
    };

    this.recreate = options.recreate ? options.recreate : true
    this.connection = connection;
    this.closed = true;
    this.listening = null;
    this.name = name || 'mubsub';
    this.cursorOptions = {
        tailable: true,
        awaitData: true,
        timeout: false,
        sortValue: { $natural: -1 },
        numberOfRetries: Number.MAX_VALUE,
        tailableRetryInterval: options.retryInterval || 200,
    };

    this.create().listen();
    this.setMaxListeners(0);
}

module.exports = Channel;
util.inherits(Channel, EventEmitter);

/**
 * Close the channel and underlying cursor, if any.
 *
 * @return {Promise} resolves on cursor close
 * @api public
 */
Channel.prototype.close = function () {
    var self = this;
    this.closed = true;

    if (this.cursor) return this.cursor.close().then(function () {
        // unreference collection
        self.collection = null;

        // unreference cursor
        self.cursor = null;
    });

    return Promise.resolve();
};

/**
 * Publish an event.
 *
 * @param {String} event
 * @param {Object} [message]
 * @param {Object} [options]
 * @return {Promise} resolves inserted document after it has been written
 * @api public
 */
Channel.prototype.publish = function (event, message, options) {
    return this.ready()
    .then(() => this.collection.insertOne({ event: event, message: message }, options || { safe: true }))
    .then(res => res.ops[0]);
};

/**
 * Subscribe an event.
 *
 * @param {String} [event] if no event passed - all events are subscribed.
 * @param {Function} callback
 * @return {Object} unsubscribe function
 * @api public
 */
Channel.prototype.subscribe = function (event, callback) {
    var self = this;

    if (typeof event == 'function') {
        callback = event;
        event = 'message';
    }

    this.on(event, callback);

    return {
        unsubscribe: function () {
            self.removeListener(event, callback);
        }
    };
};

/**
 * Create a channel collection.
 *
 * @return {Channel} this
 * @api private
 */
Channel.prototype.create = function () {
    var self = this;

    function create() {
        self.connection.db.createCollection(
            self.name,
            self.collectionOptions,
            function (err, collection) {
                if (err && err.message === 'collection already exists') {
                    return self.create();
                } else if (err) {
                    return self.emit('error', err);
                }

                self.collection = collection;
                self.emit('collection', collection);
            }
        );
    }

    this.connection.db ? create() : this.connection.once('connect', create);

    return this;
};

/**
 * Create a listener which will emit events for subscribers.
 * It will listen to any document with event property.
 *
 * @param {Object} [latest] latest document to start listening from
 * @return {Channel} this
 * @api private
 */
Channel.prototype.listen = function (latest) {
    return Promise.all([
        this.latest(latest),

        // ensure we are not leaking cursors
        this.close(),
    ])
    .then((arr) => {
        var _latest = arr[0];
        this.closed = false;
        this.cursor = this.collection.find({ _id: { $gt: _latest._id } }, this.cursorOptions);
        this.cursor.on('close', () => {
            if (this.closed || this.connection.destroyed) return;

            this.emit('error', new Error('Mubsub: broken cursor.'));
            if (this.recreate) {
                this.create().listen(_latest);
            }
        });
        this.cursor.on('data', (doc) => {
            if (this.closed || this.connection.destroyed) return;
            if (doc) {
                if (doc.event) {
                    this.emit(doc.event, doc.message);
                    this.emit('message', doc.message);
                }

                this.emit('document', doc);
            }
        });
        this.emit('ready', this.collection);
    });
};

/**
 * Get the latest document from the collection. Insert a dummy object in case
 * the collection is empty, because otherwise we don't get a tailable cursor
 * and need to poll in a loop.
 *
 * @param {Object} [latest] latest known document
 * @return {Promise} resolves latest document
 * @api private
 */
Channel.prototype.latest = function (latest) {
    var self = this;
    return new Promise(function (resolve) {
        return (self.collection ? resolve() : self.once('collection', resolve));
    })
    .then(function () {
        return self.collection
            .find(latest ? { _id: latest._id } : null, { timeout: false })
            .sort({ $natural: -1 })
            .limit(1)
            .toArray()[0];
    })
    .then(function (doc) {
        if (!doc) return self.collection.insertOne({ 'dummy': true }, { safe: true }).then(function (res) {
            return res.result.ok ? res.ops[0] : Promise.reject(new Error('failed to insert dummy'));
        });

        return doc;
    });
};

/**
 * Call back if collection is ready for publishing.
 *
 * @return {Promise} resolves when ready
 * @api private
 */
Channel.prototype.ready = function () {
    if (this.collection) {
        return Promise.resolve();
    }

    return new Promise(resolve => this.once('ready', resolve));
};
