/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

var express = require('express');
var fs =      require('fs');
var Stream =  require('stream');
var utils =   require(__dirname + '/lib/utils'); // Get common adapter utils

var session;// =           require('express-session');
var cookieParser;// =      require('cookie-parser');
var bodyParser;// =        require('cookie-parser');
var bodyParser;// =        require('body-parser');
var AdapterStore;// =      require(__dirname + '/../../lib/session.js')(session);
var passportSocketIo;// =  require(__dirname + "/lib/passport.socketio.js");
var password;// =          require(__dirname + '/../../lib/password.js');
var passport;// =          require('passport');
var LocalStrategy;// =     require('passport-local').Strategy;
var flash;// =             require('connect-flash'); // TODO report error to user

var webServer =  null;
var store =      null;
var secret =     'Zgfr56gFe87jJOM'; // Will be generated by first start
var socketUrl =  '';
var cache =      {}; // cached web files
var ownSocket =  false;
var lang =       'en';

var adapter = utils.adapter({
    name: 'web',
    install: function (callback) {
        if (typeof callback === 'function') callback();
    },
    objectChange: function (id, obj) {
        if (!ownSocket && id == adapter.config.socketio) {
            if (obj && obj.common && obj.common.enabled && obj.native) {
                socketUrl = ':' + obj.native.port;
            } else {
                socketUrl = '';
            }
        }
        if (webServer.io) webServer.io.publishAll('objectChange', id, obj);
    },
    stateChange: function (id, state) {
        if (webServer.io) webServer.io.publishAll('stateChange', id, state);
    },
    unload: function (callback) {
        try {
            adapter.log.info("terminating http" + (webServer.settings.secure ? "s" : "") + " server on port " + webServer.settings.port);
            webServer.server.close();
            adapter.log.info("terminated http" + (webServer.settings.secure ? "s" : "") + " server on port " + webServer.settings.port);

            callback();
        } catch (e) {
            callback();
        }
    },
    ready: function () {
        // Generate secret for session manager
        adapter.getForeignObject('system.adapter.web', function (err, obj) {
            if (!err && obj) {
                if (!obj.native.secret) {
                    require('crypto').randomBytes(24, function (ex, buf) {
                        secret = buf.toString('hex');
                        adapter.extendForeignObject('system.adapter.web', {native: {secret: secret}});
                        main();
                    });
                } else {
                    secret = obj.native.secret;
                    main();
                }
            } else {
                adapter.logger.error("Cannot find object system.adapter.web");
            }
        });

        // information about connected socket.io adapter
        if (adapter.config.socketio && adapter.config.socketio.match(/^system\.adapter\./)) {
            adapter.getForeignObject(adapter.config.socketio, function (err, obj) {
                if (obj && obj.common && obj.common.enabled && obj.native) socketUrl = ':' + obj.native.port;
            });
            // Listen for changes
            adapter.subscribeForeignObjects(adapter.config.socketio);
        } else {
            socketUrl = adapter.config.socketio;
            ownSocket = (socketUrl != 'none');
        }

        // Read language
        adapter.getForeignObject('system.config', function (err, data) {
            if (data && data.common) lang = data.common.language || 'en';
        });
    }
});

function main() {
    if (adapter.config.secure) {
        // Load certificates
        adapter.getForeignObject('system.certificates', function (err, obj) {
            if (err || !obj ||
                !obj.native.certificates ||
                !adapter.config.certPublic ||
                !adapter.config.certPrivate ||
                !obj.native.certificates[adapter.config.certPublic] ||
                !obj.native.certificates[adapter.config.certPrivate]
                ) {
                adapter.log.error('Cannot enable secure web server, because no certificates found: ' + adapter.config.certPublic + ', ' + adapter.config.certPrivate);
            } else {
                adapter.config.certificates = {
                    key:  obj.native.certificates[adapter.config.certPrivate],
                    cert: obj.native.certificates[adapter.config.certPublic]
                };

            }
            webServer = initWebServer(adapter.config);
        });
    } else {
        webServer = initWebServer(adapter.config);
    }
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//    "cache":  false
//}
function initWebServer(settings) {

    var server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };

    if (settings.port) {
        if (settings.secure) {
            if (!adapter.config.certificates) {
                return null;
            }
        }
        server.app = express();
        if (settings.auth) {
            session =          require('express-session');
            cookieParser =     require('cookie-parser');
            bodyParser =       require('body-parser');
            AdapterStore =     require(__dirname + '/../../lib/session.js')(session);
            passportSocketIo = require(__dirname + '/lib/passport.socketio.js');
            password =         require(__dirname + '/../../lib/password.js');
            passport =         require('passport');
            LocalStrategy =    require('passport-local').Strategy;
            flash =            require('connect-flash'); // TODO report error to user

            store = new AdapterStore({adapter: adapter});

            passport.use(new LocalStrategy(
                function (username, password, done) {

                    adapter.checkPassword(username, password, function (res) {
                        if (res) {
                            return done(null, username);
                        } else {
                            return done(null, false);
                        }
                    });
                }
            ));
            passport.serializeUser(function (user, done) {
                done(null, user);
            });

            passport.deserializeUser(function (user, done) {
                done(null, user);
            });

            server.app.use(cookieParser());
            server.app.use(bodyParser.urlencoded({
                extended: true
            }));
            server.app.use(bodyParser.json());
            server.app.use(session({
                secret: secret,
                saveUninitialized: true,
                resave: true,
                store: store
            }));
            server.app.use(passport.initialize());
            server.app.use(passport.session());
            server.app.use(flash());

            server.app.post('/login', function (req, res) {
                console.log('Redirect to ' + req.body.origin);
                var redirect = '/';
                if (req.body.origin) {
                    var parts = req.body.origin.split('=');
                    if (parts[1]) redirect = decodeURIComponent(parts[1]);
                }
                var authenticate = passport.authenticate('local', {
                    successRedirect: redirect,
                    failureRedirect: '/login/index.html' + req.body.origin + (req.body.origin ? '&error' : '?error'),
                    failureFlash: 'Invalid username or password.'
                })(req, res);
            });

            server.app.get('/logout', function (req, res) {
                req.logout();
                res.redirect('/login/index.html');
            });

            // route middleware to make sure a user is logged in
            server.app.use(function (req, res, next) {
                if (req.isAuthenticated() ||
                    /^\/login\//.test(req.originalUrl) ||
                    /\.ico$/.test(req.originalUrl)
                ) return next();
                res.redirect('/login/index.html?href=' + encodeURIComponent(req.originalUrl));
            });
        } else {
            server.app.get('/login', function (req, res) {
                res.redirect('/');
            });
            server.app.get('/logout', function (req, res) {
                res.redirect('/');
            });
        }

        // Init read from states
        server.app.get('/state/*', function (req, res) {
            try {
                var fileName = req.url.split('/', 3)[2].split('?', 2);
                adapter.getBinaryState(fileName[0], function (err, obj) {
                    if (!err && obj !== null && obj !== undefined) {
                        res.set('Content-Type', 'text/plain');
                        res.send(obj);
                    } else {
                        res.status(404).send('404 Not found. File ' + fileName[0] + ' not found');
                    }
                });
            } catch (e) {
                res.status(500).send('500. Error' + e);
            }
        });

        server.app.get('/_socket/info.js', function (req, res) {
            res.set('Content-Type', 'application/javascript');
            res.send('var socketUrl = "' + socketUrl + '"; var socketSession = "' + '' + '"; sysLang="' + lang + '";');
        });

        // Enable CORS
        if (settings.socketio) {
            server.app.use(function (req, res, next) {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
                res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, *');

                // intercept OPTIONS method
                if ('OPTIONS' == req.method) {
                    res.send(200);
                } else {
                    next();
                }
            });
        }

        var appOptions = {};
        if (settings.cache) appOptions.maxAge = 30758400000;

        // deliver web files from objectDB
        server.app.use('/', function (req, res) {
            var url = req.url;

            if (server.api && server.api.checkRequest(url)) {
                server.api.restApi(req, res);
                return;
            }

            // add index.html
            url = url.replace(/\/($|\?|#)/, '/index.html$1');

            if (url.match(/^\/adapter\//)) {
                // add .admin to adapter name
                url = url.replace(/^\/adapter\/([a-zA-Z0-9-_]+)\//, '/$1.admin/');
            }

            if (url.match(/^\/lib\//)) {
                url = '/web' + url;
            }

            url = url.split('/');
            // Skip first /
            url.shift();
            // Get ID
            var id = url.shift();
            url = url.join('/');
            var pos = url.indexOf('?');
            if (pos != -1) {
                url = url.substring(0, pos);
            }
            if (settings.cache && cache[id + '/' + url]) {
                res.contentType(cache[id + '/' + url].mimeType);
                res.send(cache[id + '/' + url].buffer);
            } else {
                if (id == 'login' && url == 'index.html') {
                    var buffer = fs.readFileSync(__dirname + '/www/login/index.html');
                    if (buffer === null || buffer === undefined) {
                        res.contentType('text/html');
                        res.send('File ' + url + ' not found', 404);
                    } else {
                        // Store file in cache
                        if (settings.cache) {
                            cache[id + '/' + url] = {buffer: buffer.toString(), mimeType: 'text/html'};
                        }
                        res.contentType('text/html');
                        res.send(buffer.toString());
                    }

                } else {
                    adapter.readFile(id, url, null, function (err, buffer, mimeType) {
                        if (buffer === null || buffer === undefined || err) {
                            res.contentType('text/html');
                            res.send('File ' + url + ' not found', 404);
                        } else {
                            // Store file in cache
                            if (settings.cache) {
                                cache[id + '/' + url] = {buffer: buffer, mimeType: mimeType || 'text/javascript'};
                            }
                            res.contentType(mimeType || 'text/javascript');
                            res.send(buffer);
                        }
                    });
                }
            }
        });

        if (settings.secure) {
            server.server = require('https').createServer(adapter.config.certificates, server.app);
        } else {
            server.server = require('http').createServer(server.app);
        }
        server.server.__server = server;
    } else {
        adapter.log.error('port missing');
        process.exit(1);
    }

    if (server.server) {
        adapter.getPort(settings.port, function (port) {
            if (port != settings.port && !adapter.config.findNextPort) {
                adapter.log.error('port ' + settings.port + ' already in use');
                process.exit(1);
            }
            server.server.listen(port);
            adapter.log.info('http' + (settings.secure ? 's' : '') + ' server listening on port ' + port);
        });
    }

    // Activate integrated simple API
    if (settings.simpleapi) {
        var SimpleAPI = require(__dirname + '/node_modules/iobroker.simple-api/lib/simpleapi.js');
        server.api = new SimpleAPI(server.server, {secure: settings.secure, port: settings.port}, adapter);
    }

    // Activate integrated socket
    if (ownSocket) {
        var IOBrokerSocket = require(__dirname + '/node_modules/iobroker.socketio/lib/iobrokersocket.js');
        server.io = new IOBrokerSocket(server.server, settings, adapter)
    }

    if (server.server) {
        return server;
    } else {
        return null;
    }
}
