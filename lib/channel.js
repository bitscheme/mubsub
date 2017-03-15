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
function Channel(connection, name, options) {
    options || (options = {});

    this.collectionOptions = {
        capped: true,
        // In mongo v <= 2.2 index for _id is not done by default
        autoIndexId: true,
        size: options.size || 1024 * 1024 * 5,
        strict: false,
    };

    this.options = options;
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
        tailableRetryInterval: this.options.retryInterval
    };

    this.create().listen();
    this.setMaxListeners(0);
}

module.exports = Channel;
util.inherits(Channel, EventEmitter);

/**
 * Close the channel and underlying cursor, if any.
 *
 * @return {Promise} close promise
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
 * @param {Function} [callback]
 * @return {Channel} this
 * @api public
 */
Channel.prototype.publish = function (event, message, callback) {
    var options = callback ? { safe: true } : {};
    callback || (callback = noop);

    this.ready(function (collection) {
        collection.insert({ event: event, message: message }, options, function (err, docs) {
            if (err) return callback(err);
            callback(null, docs.ops[0]);
        });
    });

    return this;
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
            this.collectionOptions,
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
    var self = this;

    return Promise.all([
        self.latest(latest),

        // ensure we are not leaking cursors
        self.close(),
    ])
    .then(function (arr) {
        var _latest = arr[0];
        self.cursor = self.collection.find(
            { _id: { $gt: _latest._id }},
            this.cursorOptions
        );
        self.closed = false;

        self.emit('ready', self.collection);
        process.nextTick(function () {
            listenForNext();
        });
    });
};

function handleNext(self, doc) {
    if (self.closed || self.connection.destroyed) return;

    // There is no document only if the cursor is closed by accident.
    // F.e. if collection was dropped or connection died.
    if (!doc) {
        return process.nextTick(function () {
            self.emit('error', new Error('Mubsub: broken cursor.'));
            if (self.options.recreate) {
                self.create().listen(latest);
            }
        });
    }

    if (doc.event) {
        self.emit(doc.event, doc.message);
        self.emit('message', doc.message);
    }

    self.emit('document', doc);

    process.nextTick(function () {
        listenForNext(self);
    });
}

function listenForNext(self) {
    return (self.cursor ? self.cursor.next() : Promise.resolve())
    .then(function (doc) {
        handleNext(doc);
    })
    .catch(function (error) {
        self.emit('error', error);
        handleNext();
    });
}

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
        return self.collection.findOne(
            latest ? { _id: latest._id } : null, {timeout: false},
            {
                sort: { $natural: -1 },
                limit: 1,
            }
        );
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
 * @param {Function} callback
 * @return {Channel} this
 * @api private
 */
Channel.prototype.ready = function (callback) {
    if (this.collection) {
        callback(this.collection);
    } else {
        this.once('ready', callback);
    }

    return this;
};
