var React = require('react'),
    Router = require('react-router'),
    Addons = require('react/addons'),
    $ = require('jquery'),
    DefaultRoute = Router.DefaultRoute,
    Link = Router.Link,
    Route = Router.Route,
    RouteHandler = Router.RouteHandler,
    NotFoundRoute = Router.NotFoundRoute;

var ace = require('brace');
require('brace/mode/json');
require('brace/theme/monokai');

var globalUrlPrefix;
var globalAuthUrl;
var globalSocketUrl;
var globalInfoUrl;
var globalActionUrl;

$.ajaxPrefilter(function (options, originalOptions, jqXHR) {
    var token = localStorage.getItem("token");
    if (token) {
        jqXHR.setRequestHeader('Authorization', "Token " + localStorage.getItem("token"));
    }
});

function prettifyJson(json) {
    return syntaxHighlight(JSON.stringify(json, undefined, 4));
}

function syntaxHighlight(json) {
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        var cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
            } else {
                cls = 'string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'boolean';
        } else if (/null/.test(match)) {
            cls = 'null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}

var App = React.createClass({
    mixins: [Router.State],
    getInitialState: function () {
        return {
            isAuthenticated: false
        }
    },
    componentWillMount: function () {
        var token = localStorage.getItem("token");
        if (token) {
            this.setState({isAuthenticated: true});
        }
    },
    handleLogin: function (password) {
        $.post(globalAuthUrl, {password: password}, "json").success(function (data) {
            localStorage.setItem("token", data.token);
            this.setState({isAuthenticated: true});
        }.bind(this)).error(function () {
            $.noop();
        });
    },
    handleLogout: function () {
        delete localStorage.token;
        this.setState({isAuthenticated: false});
    },
    render: function () {
        if (this.state.isAuthenticated) {
            return (
                <Dashboard handleLogout={this.handleLogout} handleLogout={this.handleLogout} {...this.props} />
            )
        } else {
            return (
                <Login handleLogin={this.handleLogin} {...this.props}></Login>
            )
        }
    }
});

var conn;
var reconnectTimeout;
var infoLoadTimeout;
var pingInterval;
var maxMessageAmount = 50;

var Dashboard = React.createClass({
    mixins: [Router.State],
    getInitialState: function () {
        var protocol = window.location.protocol;
        var isSecure = protocol === "https:";
        var sockjsProtocol = isSecure ? "https://" : "http://";
        var websocketProtocol = isSecure ? "wss://" : "ws://";
        var sockjsEndpoint = sockjsProtocol + window.location.host + globalUrlPrefix + 'connection';
        var wsEndpoint = websocketProtocol + window.location.host + globalUrlPrefix + 'connection/websocket';
        var apiEndpoint = sockjsProtocol + window.location.host + globalUrlPrefix + 'api';
        return {
            isConnected: false,
            channelOptions: [],
            namespaces: [],
            structureDict: {},
            version: "",
            secret: "",
            connectionLifetime: 0,
            engine: "",
            nodeName: "",
            nodeCount: "",
            sockjsEndpoint: sockjsEndpoint,
            wsEndpoint: wsEndpoint,
            apiEndpoint: apiEndpoint,
            nodes: {},
            messages: [],
            messageCounter: 0
        }
    },
    handleAuthBody: function (body) {
        if (body === true) {
            this.setState({isConnected: true});
            pingInterval = setInterval(function() {
                conn.send(JSON.stringify({
                    "method": "ping",
                    "params": {}
                }));
            }.bind(this), 25000);
        } else {
            this.props.handleLogout();
        }
    },
    handleMessageBody: function (body) {
        var message = body.message;
        var currentMessages = this.state.messages.slice();
        var d = new Date();
        message['time'] = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        currentMessages.unshift(message);
        // splice array to keep max message amount
        currentMessages = currentMessages.splice(0, maxMessageAmount);
        this.setState({messages: currentMessages});
        var name = this.getRoutes().reverse()[0].name;
        var isMessagesOpen = name === "messages";
        if (!isMessagesOpen) {
            var currentCounter = this.state.messageCounter;
            this.setState({messageCounter: currentCounter + 1});
        }
    },
    connectWs: function () {
        var protocol = window.location.protocol;
        var isSecure = protocol === "https:";
        var websocketProtocol = isSecure ? "wss://" : "ws://";
        conn = new WebSocket(websocketProtocol + window.location.host + globalSocketUrl);
        conn.onopen = function () {
            conn.send(JSON.stringify({
                "method": "auth",
                "params": {
                    "token": localStorage.getItem("token")
                }
            }));
        }.bind(this);
        conn.onmessage = function (event) {
            var data = JSON.parse(event.data);
            var method = data.method;
            var body = data.body;
            if (method === "auth") {
                this.handleAuthBody(body);
            } else if (method === "message") {
                this.handleMessageBody(body);
            } else if (method === "ping") {
                $.noop();
            } else {
                console.log("unknown method " + method);
            }
        }.bind(this);
        conn.onerror = function () {
            this.setState({isConnected: false});
        }.bind(this);
        conn.onclose = function () {
            if (this.isMounted()) {
                this.setState({isConnected: false});
                reconnectTimeout = setTimeout(function () {
                    this.connectWs();
                }.bind(this), 3000);
            }
            if (pingInterval) {
                clearInterval(pingInterval);
            }
        }.bind(this);
    },
    clearMessageCounter: function () {
        this.setState({messageCounter: 0});
    },
    loadInfo: function() {
        $.get(globalInfoUrl, {}, function (data) {
            this.setState({
                version: data.version,
                channelOptions: data.channel_options,
                namespaces: data.namespaces,
                engine: data.engine,
                nodeName: data.node_name,
                nodeCount: Object.keys(data.nodes).length,
                nodes: data.nodes,
                secret: data.secret,
                connectionLifetime: data.connection_lifetime
            });
        }.bind(this), "json").error(function (jqXHR) {
            if (jqXHR.status === 401) {
                this.props.handleLogout();
            }
        }.bind(this));

        infoLoadTimeout = setTimeout(function(){
            this.loadInfo();
        }.bind(this), 10000);
    },
    componentDidMount: function () {
        this.loadInfo();
        this.connectWs();
    },
    componentWillUnmount: function () {
        if (conn) {
            conn.close();
        }
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
        }
        if (infoLoadTimeout) {
            clearTimeout(infoLoadTimeout)
        }
    },
    render: function () {
        return (
            <div>
                <Nav handleLogout={this.props.handleLogout} />
                <div className="wrapper">
                    <Sidebar messageCounter={this.state.messageCounter} />
                    <div className="col-lg-10 col-md-10 col-sm-12 col-xs-12">
                        <ConnectionStatus isConnected={this.state.isConnected} />
                        <RouteHandler
                            dashboard={this.state}
                            handleLogout={this.props.handleLogout}
                            clearMessageCounter={this.clearMessageCounter}
                        {...this.props} />
                    </div>
                </div>
            </div>
        )
    }
});

var Login = React.createClass({
    handleSubmit: function (e) {
        e.preventDefault();
        var password = this.refs.password.getDOMNode().value;
        this.props.handleLogin(password);
    },
    render: function () {
        return (
            <div className="login">
                <a href="https://github.com/centrifugal" target="_blank">
                    <img className="login-forkme" src="https://camo.githubusercontent.com/38ef81f8aca64bb9a64448d0d70f1308ef5341ab/68747470733a2f2f73332e616d617a6f6e6177732e636f6d2f6769746875622f726962626f6e732f666f726b6d655f72696768745f6461726b626c75655f3132313632312e706e67" alt="Fork me on GitHub" data-canonical-src="https://s3.amazonaws.com/github/ribbons/forkme_right_darkblue_121621.png" />
                </a>
                <div className="login-body">
                    <div className="container">
                        <div className="row">
                            <div className="col-md-8 col-md-offset-2">
                                <div className="login-logo"></div>
                                <h1 className="login-heading">Centrifugal</h1>
                                <p className="login-text">Real-time messaging in web applications</p>
                                <form action="" method="post" className="login-form" onSubmit={this.handleSubmit}>
                                    <div className="form-group">
                                        <input ref="password" className="form-control" type="password" name="password" placeholder="Type password to log in..."/>
                                    </div>
                                    <button type="submit" className="btn btn-success login-submit">Log In <i className="glyphicon glyphicon-log-in"></i></button>
                                </form>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )
    }
});

var Nav = React.createClass({
    handleLogout: function (e) {
        e.preventDefault();
        this.props.handleLogout();
    },
    render: function () {
        return (
            <nav className="navbar navbar-inverse" role="navigation">
                <div className="navbar-header">
                    <button data-target=".navbar-ex8-collapse" data-toggle="collapse" className="navbar-toggle" type="button">
                        <span className="sr-only">Toggle navigation</span>
                        <span className="icon-bar"></span>
                        <span className="icon-bar"></span>
                        <span className="icon-bar"></span>
                    </button>
                    <Link to="status" className="navbar-brand">
                        <span className="navbar-logo">
                        </span>
                        Centrifugal web
                    </Link>
                </div>
                <div className="collapse navbar-collapse navbar-ex8-collapse">
                    <ul className="nav navbar-nav">
                        <li>
                            <a href="http://fzambia.gitbooks.io/centrifugal/content/" target="_blank">
                                Documentation
                            </a>
                        </li>
                        <li>
                            <a href="https://github.com/centrifugal" target="_blank">
                                Source code
                            </a>
                        </li>
                        <li>
                            <a href="#" onClick={this.handleLogout}>Logout</a>
                        </li>
                    </ul>
                </div>
            </nav>
        )
    }
});

var Sidebar = React.createClass({
    mixins: [Router.State],
    render: function () {
        var cx = Addons.addons.classSet;
        var isStatusActive = this.isActive('status', {}, {});
        var statusClasses = cx({'active': isStatusActive});
        var isOptionsActive = this.isActive('options', {}, {});
        var optionsClasses = cx({'active': isOptionsActive});
        var isMessagesActive = this.isActive('messages', {}, {});
        var messagesClasses = cx({'active': isMessagesActive});
        var isActionsActive = this.isActive('actions', {}, {});
        var actionsClasses = cx({'active': isActionsActive});
        return (
            <div className="col-lg-2 col-md-2 col-sm-12 col-xs-12 sidebar">
                <ul className="nav nav-pills nav-stacked">
                    <li className={statusClasses}>
                        <Link to="status">
                            <i className="glyphicon glyphicon-equalizer"></i>&nbsp;Status
                        </Link>
                    </li>
                    <li className={optionsClasses}>
                        <Link to="options">
                            <i className="glyphicon glyphicon-cog"></i>&nbsp;Options
                        </Link>
                    </li>
                    <li className={messagesClasses}>
                        <Link to="messages">
                            <i className="glyphicon glyphicon-envelope"></i>&nbsp;Messages
                            <span className="badge">{this.props.messageCounter > 0?this.props.messageCounter:""}</span>
                        </Link>
                    </li>
                    <li className={actionsClasses}>
                        <Link to="actions">
                            <i className="glyphicon glyphicon-fire"></i>&nbsp;Actions
                        </Link>
                    </li>
                </ul>
            </div>
        )
    }
});

var ConnectionStatus = React.createClass({
    getDefaultProps: function () {
        return {
            isConnected: false
        }
    },
    render: function () {
        if (this.props.isConnected) {
            return (
                <span className="pull-right connected label label-success" title='connected to Centrifuge'>
                    connected
                </span>
            )
        } else {
            return (
                <span className="pull-right not-connected label label-danger" title='disconnected from Centrifuge'>
                    disconnected
                </span>
            )
        }
    }
});

var StatusHandler = React.createClass({
    getInitialState: function () {
        return {}
    },
    componentDidMount: function () {
    },
    render: function () {
        var nodeRows;
        if (Object.keys(this.props.dashboard.nodes).length > 0) {
            nodeRows = [];
            for (var uid in this.props.dashboard.nodes) {
                if (this.props.dashboard.nodes.hasOwnProperty(uid)) {
                    var node = this.props.dashboard.nodes[uid];
                    nodeRows.push(<NodeRow node={node} key={uid} />);
                }
            }
        } else {
            nodeRows = <NodeRowLoader />;
        }
        return (
            <div className="content">
                <div className="stat-row">
                    <span className="text-muted stat-key">Version:</span>
                &nbsp;
                    <span className="stat-value">{this.props.dashboard.version}</span>
                </div>
                <div className="stat-row">
                    <span className="text-muted stat-key">SockJS endpoint:</span>
                &nbsp;
                    <span className="stat-value">{this.props.dashboard.sockjsEndpoint}</span>
                </div>
                <div className="stat-row">
                    <span className="text-muted stat-key">WebSocket endpoint:</span>
                &nbsp;
                    <span className="stat-value">{this.props.dashboard.wsEndpoint}</span>
                </div>
                <div className="stat-row">
                    <span className="text-muted stat-key">HTTP API endpoint:</span>
                &nbsp;
                    <span className="stat-value">{this.props.dashboard.apiEndpoint}</span>
                </div>
                <div className="stat-row">
                    <span className="text-muted stat-key">Engine:</span>
                &nbsp;
                    <span className="stat-value">{this.props.dashboard.engine}</span>
                </div>
                <div className="stat-row">
                    <span className="text-muted stat-key">Current node:</span>
                &nbsp;
                    <span className="stat-value" id="current-node">{this.props.dashboard.nodeName}</span>
                </div>
                <div className="stat-row">
                    <span className="text-muted stat-key">Nodes running:</span>
                &nbsp;
                    <span className="stat-value" id="node-count">{this.props.dashboard.nodeCount}</span>
                </div>
                <div className="node_info">
                    <table className="table table-bordered">
                        <thead className="cf">
                            <tr>
                                <th title="node name">Node name</th>
                                <th title="total active channels">Channels</th>
                                <th title="total connected clients">Clients</th>
                                <th title="total unique clients">Unique Clients</th>
                            </tr>
                        </thead>
                        <tbody id="node-info">
                            {nodeRows}
                        </tbody>
                    </table>
                </div>
            </div>
        )
    }
});

var NodeRowLoader = React.createClass({
    render: function () {
        return (
            <tr>
                <td colSpan="4">Waiting for information...</td>
            </tr>
        )
    }
});

var NodeRow = React.createClass({
    render: function () {
        return (
            <tr>
                <td>{this.props.node.name}</td>
                <td>{this.props.node.num_channels}</td>
                <td>{this.props.node.num_clients}</td>
                <td>{this.props.node.num_unique_clients}</td>
            </tr>
        )
    }
});

var NamespaceRow = React.createClass({
    render: function () {
        var options = $.extend({}, this.props.namespace);
        delete options["name"];
        var optionsJson = prettifyJson(options);
        return (
            <div>
                <h5>{this.props.namespace.name}:</h5>
                <pre dangerouslySetInnerHTML={{"__html": optionsJson}} />
            </div>
        )
    }
});

var NamespaceTable = React.createClass({
    render: function () {
        var namespaces = this.props.namespaces;
        return (
            <div>
                {namespaces.map(function (namespace, index) {
                    return (
                        <NamespaceRow key={index} namespace={namespace} />
                    )
                })}
            </div>
        )
    }
});

var NamespacesNotConfigured = React.createClass({
    render: function () {
        return (
            <pre>
                Namespaces not configured
            </pre>
        )
    }
});

var NotFoundHandler = React.createClass({
    render: function () {
        return (
            <div className="content">
                <h2>404 not found</h2>
            </div>
        )
    }
});

var OptionsHandler = React.createClass({
    mixins: [Router.State],
    getInitialState: function () {
        return {
            secretHidden: true
        }
    },
    toggleSecret: function() {
        var secretHidden = this.state.secretHidden;
        if (secretHidden) {
            this.setState({secretHidden: !secretHidden});
        }
    },
    render: function () {
        var options = this.props.dashboard.channelOptions || {};
        var optionsJson = prettifyJson(options);
        var namespaces = this.props.dashboard.namespaces || [];
        var cx = Addons.addons.classSet;
        var secretClasses = cx({
            "secret-hidden": this.state.secretHidden
        });
        var secretText;
        if (this.state.secretHidden) {
            secretText = "click to see secret";
        } else {
            secretText = this.props.dashboard.secret;
        }
        var connLifetimeText;
        if (this.props.dashboard.connectionLifetime == 0) {
            connLifetimeText = "Client connections do not expire (connection_lifetime=0)";
        } else {
            connLifetimeText = "Client must refresh its connection every " + this.props.dashboard.connectionLifetime + " seconds";
        }
        var ns;
        if (namespaces.length > 0) {
            ns = <NamespaceTable namespaces={namespaces} />
        } else {
            ns = <NamespacesNotConfigured />
        }
        return (
            <div className="content">
                <p className="content-help">Various important configuration options here</p>
                <h4>Secret</h4>
                <pre className={secretClasses} onClick={this.toggleSecret}>{secretText}</pre>
                <h4>Channel options</h4>
                <pre dangerouslySetInnerHTML={{"__html": optionsJson}} />
                <h4>Namespaces</h4>
                {ns}
                <h4>Connection Lifetime</h4>
                <pre>{connLifetimeText}</pre>
            </div>
        )
    }
});

var MessagesHandler = React.createClass({
    mixins: [Router.State],
    componentDidMount: function () {
        this.props.clearMessageCounter();
    },
    render: function () {
        var messages = this.props.dashboard.messages;
        if (!messages) {
            messages = [];
        }
        return (
            <div className="content">
                <p className="content-help">Waiting for messages from channels with "watch" option enabled...</p>
                {messages.map(function (message, index) {
                    return (
                        <Message key={index} message={message} />
                    )
                })}
            </div>
        )
    }
});

var ActionsHandler = React.createClass({
    mixins: [Router.State],
    editor: null,
    getInitialState: function () {
        return {
            "response": null
        }
    },
    handleMethodChange: function () {
        var fields = ["channel", "data", "user"];
        var methodFields = {
            "publish": ["channel", "data"],
            "presence": ["channel"],
            "history": ["channel"],
            "unsubscribe": ["channel", "user"],
            "disconnect": ["user"],
            "channels": [],
            "stats": []
        };
        var method = $(this.refs.method.getDOMNode()).val();
        if (!method) {
            return;
        }
        var fieldsToShow = methodFields[method];
        for (var i in fieldsToShow) {
            var field = $('#' + fieldsToShow[i]);
            field.attr('disabled', false).parents('.form-group:first').show();
        }
        for (var k in fields) {
            var field_name = fields[k];
            if (fieldsToShow.indexOf(field_name) === -1) {
                $('#' + field_name).attr('disabled', true).parents('.form-group:first').hide();
            }
        }
    },
    componentDidMount: function () {
        this.editor = ace.edit('data-editor');
        this.editor.getSession().setMode('ace/mode/json');
        this.editor.setTheme('ace/theme/monokai');
        this.editor.setShowPrintMargin(false);
        this.editor.getSession().setUseSoftTabs(true);
        this.editor.getSession().setUseWrapMode(true);
        this.handleMethodChange();
    },
    hideError: function() {
        var error = $(this.refs.error.getDOMNode());
        error.hide();
    },
    hideSuccess: function() {
        var success = $(this.refs.success.getDOMNode());
        success.hide();
    },
    showError: function(text) {
        this.hideSuccess();
        this.setState({response: null});
        var error = $(this.refs.error.getDOMNode());
        error.stop().hide().removeClass("hidden").text(text).fadeIn();
    },
    showSuccess: function() {
        this.hideError();
        var success = $(this.refs.success.getDOMNode());
        success.stop().hide().removeClass('hidden').fadeIn();
    },
    handleSubmit: function (e) {
        e.preventDefault();
        var form = $(this.refs.form.getDOMNode());
        if ($(this.refs.method.getDOMNode()).val() === "publish") {
            var data = this.editor.getSession().getValue();
            try {
                var json = JSON.stringify(JSON.parse(data));
            } catch (e) {
                this.showError("malformed JSON");
                return;
            }
        }
        $(this.refs.data.getDOMNode()).val(json);
        var submitButton = $(this.refs.submit.getDOMNode());
        submitButton.attr('disabled', true);
        $.post(globalActionUrl, form.serialize(), function (data) {
            var json = prettifyJson(data);
            this.setState({response: json});
            submitButton.attr('disabled', false);
            this.showSuccess();
        }.bind(this), "json").error(function (jqXHR) {
            if (jqXHR.status === 401) {
                this.props.handleLogout();
            }
            this.showError("Error");
        }.bind(this));
    },
    render: function () {
        return (
            <div className="content">
                <p className="content-help">Execute command on server</p>
                <form ref="form" role="form" method="POST" action="" onSubmit={this.handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="method">Method</label>
                        <select className="form-control" ref="method" name="method" id="method" onChange={this.handleMethodChange}>
                            <option value="publish">publish</option>
                            <option value="presence">presence</option>
                            <option value="history">history</option>
                            <option value="unsubscribe">unsubscribe</option>
                            <option value="disconnect">disconnect</option>
                            <option value="channels">channels</option>
                            <option value="stats">stats</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label htmlFor="channel">Channel</label>
                        <input type="text" className="form-control" name="channel" id="channel" />
                    </div>
                    <div className="form-group">
                        <label htmlFor="user">User ID</label>
                        <input type="text" className="form-control" name="user" id="user" />
                    </div>
                    <div className="form-group">
                        <label htmlFor="data">Data</label>
                        <div id="data-editor"></div>
                        <textarea ref="data" className="hidden" id="data" name="data"></textarea>
                    </div>
                    <button type="submit" ref="submit" className="btn btn-primary">Submit</button>
                    <span ref="error" className="box box-error hidden">Error</span>
                    <span ref="success" className="box box-success hidden">Successfully sent</span>
                </form>
                <div className="action-response">
                    <pre ref="response" dangerouslySetInnerHTML={{"__html": this.state.response}} />
                </div>
            </div>
        )
    }
});

var pad = function (n) {
    // http://stackoverflow.com/a/3313953/1288429
    return ("0" + n).slice(-2);
};

var Message = React.createClass({
    render: function () {
        return (
            <div className="message">
                <div className="message-header">
                    <span className="message-channel text-muted">
                        {this.props.message.channel}
                    </span>
                    <span className="message-time text-muted">{this.props.message.time}</span>
                </div>
                <div className="message-description">
                    <pre dangerouslySetInnerHTML={{"__html": prettifyJson(this.props.message.data)}} />
                </div>
            </div>
        )
    }
});

var routes = (
    <Route handler={App}>
        <DefaultRoute name="status" handler={StatusHandler} />
        <Route name="options" path="/options/" handler={OptionsHandler} />
        <Route name="messages" path="/messages/" handler={MessagesHandler} />
        <Route name="actions" path="/actions/" handler={ActionsHandler} />
        <NotFoundRoute name="404" handler={NotFoundHandler} />
    </Route>
);

module.exports = function () {
    Router.run(routes, function (Handler, state) {
        var app = document.getElementById("app");
        var prefix = app.dataset.prefix || "/";
        globalUrlPrefix = prefix;
        globalAuthUrl = prefix + "auth/";
        globalInfoUrl = prefix + "info/";
        globalActionUrl = prefix + "action/";
        globalSocketUrl = prefix + "socket";
        React.render(<Handler query={state.query} />, app);
    });
};

