var mubsub = require('../lib/index');
var memwatch = require("node-memwatch");

memwatch.on('leak', function(info) { console.log(info) });
memwatch.on('stats', function(stats) { console.log(stats)});

var client = mubsub(process.env.MONGODB_URI || 'mongodb://localhost:27017/mubsub_example');
var channel = client.channel('example');

channel.on('error', console.error);
client.on('error', console.error);

channel.subscribe('foo', function (message) {
   // console.log(message);
});
