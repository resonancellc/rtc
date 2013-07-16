﻿'use strict';

(function (exports) {
	var xrtc = exports.xRtc;

	xrtc.Class(xrtc, 'Room', function Room(info, am, sc) {
		var proxy = xrtc.Class.proxy(this),
			logger = new xrtc.Logger(this.className),
			hcEvents = xrtc.HandshakeController.events,
			scEvents = xrtc.ServerConnector.events,
			participants = [],
			isServerConnectorSubscribed = false,
			roomOptions = {},
			roomInfo = {},
			currentUserData = null,
			authManager = am || new xRtc.AuthManager(),
			serverConnector = sc || new xrtc.ServerConnector(),
			connections = [],
			handshakeControllers = {};

		// roomInfo initialization
		xrtc.Class.extend(roomInfo, xrtc.Room.settings.info);
		if (typeof info === 'string') {
			roomInfo.name = info;
		} else {
			xrtc.Class.extend(roomInfo, info);
		}

		xrtc.Class.extend(this, xrtc.EventDispatcher, {
			_logger: logger,

			enter: function (userName, options) {
				subscribeToServerEvents.call(this);

				// roomOptions initialization
				xrtc.Class.extend(roomOptions, xrtc.Connection.settings.options);
				if (options) {
					xrtc.Class.extend(roomOptions, options);
				};

				currentUserData = {
					domain: roomInfo.domain,
					application: roomInfo.application,
					room: roomInfo.name,
					name: userName
				};

				authManager.getToken(currentUserData, function (token) {
					// todo: think about best place of this initialization
					roomInfo.user = userName;

					serverConnector.connect(token);
				});
			},

			leave: function () {
				serverConnector.disconnect();

				unsubscribeFromServerEvents.call(this);

				roomOptions = {};
				currentUserData = null;
				roomInfo.user = null;
				participants = [];

				//todo: maybe will be good to close all room connections. Need to discuss it with the team.
				connections = [],
				handshakeControllers = {};
			},

			connect: function (participantId, connectionOptions) {
				if (!roomInfo.user) {
					throw new xrtc.CommonError('connect', 'Need to enter the room before you connect someone.');
				}

				// todo: get userdata or something like this

				createConnection.call(this, currentUserData, participantId, function (connectionData) {
					var connection = connectionData.connection;
					// todo: need to prepare valid media content options
					/*if (mediaContentOptions) {
						// todo: if neccessary, appropriate data channels should be created here. Pseudo code was added for now.
						var channels = getChannels(mediaContentOptions);
						for (var i = 0, len = channels.length; i < len; i++) {
							connection.createDataChannel(channels[i].name);
						}
					}*/

					connection.open(participantId, connectionOptions);
				});
			},

			getInfo: function () {
				return roomInfo;
			},

			getConnections: function () {
				return connections;
			},

			getParticipants: function () {
				//return the copy of array
				return participants.map(function (participant) {
					return participant;
				});
			}
		});

		function subscribeToServerEvents() {
			if (!isServerConnectorSubscribed) {
				serverConnector
					.on(scEvents.connectionOpen, proxy(function (event) { this.trigger(xrtc.Room.events.enter); }))
					.on(scEvents.connectionClose, proxy(function (event) { this.trigger(xrtc.Room.events.leave); }))
					.on(scEvents.tokenInvalid, proxy(function (event) { this.trigger(xrtc.Room.events.tokenInvalid); }))
					.on(scEvents.participantsUpdated, proxy(function (data) {
						participants = data.connections;
						sortParticipants();

						this.trigger(xrtc.Room.events.participantsUpdated, { participants: this.getParticipants() });
					}))
					.on(scEvents.participantConnected, proxy(function (data) {
						participants.push(data.participantId);
						sortParticipants();

						this.trigger(xrtc.Room.events.participantConnected, { participantId: data.participantId });
					}))
					.on(scEvents.participantDisconnected, proxy(function (data) {
						participants.splice(participants.indexOf(data.participantId), 1);
						sortParticipants();

						this.trigger(xrtc.Room.events.participantDisconnected, { participantId: data.participantId });
					}))
					.on(scEvents.receiveOffer, proxy(onIncomingConnection))
					.on(scEvents.receiveBye, proxy(onCloseConnection));

				isServerConnectorSubscribed = true;
			}
		}

		function unsubscribeFromServerEvents() {
			if (isServerConnectorSubscribed) {
				serverConnector
					.off(scEvents.participantsUpdated)
					.off(scEvents.participantConnected)
					.off(scEvents.participantDisconnected);

				// todo: what about another events? (connectionOpen, connectionClose, tokenInvalid). Need to think about it later.

				isServerConnectorSubscribed = false;
			}
		}

		function sortParticipants() {
			participants.sort();
		}

		function getConnectionIndexById(connectionsArray, connectionId) {
			var resultIndex = null;
			for (var i = 0, len = connectionsArray.length; i < len; i++) {
				if (connectionsArray[i].getId() === connectionId) {
					resultIndex = i;
					break;
				}
			}

			return resultIndex;
		}

		function onIncomingConnection(data) {
			// Skip 'offer' if it is not for me. It is temporary fix, because server shouldn't pass the 'offer' to wrong target.
			// Sometimes it happened that the server had sent the 'offer' to all/wrong participants. So we decided not touch this check.
			if (data.receiverId !== roomInfo.user) {
				return;
			}

			var self = this;

			if (!roomOptions.autoReply) {
				data.accept = proxy(onAcceptCall);
				data.decline = proxy(onDeclineCall);
			}

			this.trigger(xrtc.Room.events.incomingConnection, data);

			if (roomOptions.autoReply) {
				onAcceptCall.call(self);
			}

			function onAcceptCall() {
				createConnection.call(self, currentUserData, data.senderId, function (connectionData) {
					//todo: need to think about offer data format
					var offerData = data.offer;
					offerData.connectionId = data.connectionId;

					connectionData.handshakeController.trigger(hcEvents.receiveOffer, offerData);
				});
			}

			function onDeclineCall() {
				//todo: need to think about 'bye' options definition and about senderId property name
				serverConnector.sendBye(data.senderId, data.connectionId, null, { type: 'decline' });
			}
		}

		function onCloseConnection(data) {
			if (data.options && data.options.type === 'decline') {
				this.trigger(xrtc.Room.events.connectionDeclined, { userId: data.senderId, connectionId: data.connectionId });
			}

			var targetHc = handshakeControllers[data.targetConnectionId];
			if (targetHc) {
				targetHc.trigger(hcEvents.receiveBye, data);
			}
		}

		function createConnection(userData, targetUserId, connectionCreated) {
			var self = this;
			var hc = new xrtc.HandshakeController();

			var connection = new xRtc.Connection(userData, targetUserId, hc, authManager);
			var connectionId = connection.getId();

			handshakeControllers[connectionId] = hc;

			var eventsMapping = {};
			eventsMapping[scEvents.receiveAnswer] = hcEvents.receiveAnswer;
			eventsMapping[scEvents.receiveIce] = hcEvents.receiveIce;
			eventsMapping[scEvents.receiveBye] = hcEvents.receiveBye;
			for (var event in eventsMapping) {
				if (eventsMapping.hasOwnProperty(event)) {
					(function (eventName) {
						serverConnector.on(eventName, function (data) {
							if (data.targetConnectionId) {
								var targetHc = handshakeControllers[data.targetConnectionId];
								if (targetHc) {
									targetHc.trigger(eventsMapping[eventName], data);
								}
							}
						});
					})(event);
				}
			}

			hc.on(hcEvents.sendOffer, proxy(function (tUserId, tConnId, connId, sd) {
				serverConnector.sendOffer(tUserId, tConnId, connId, sd);
			}))
			.on(hcEvents.sendAnswer, proxy(function (tUserId, tConnId, connId, sd) {
				serverConnector.sendAnswer(tUserId, tConnId, connId, sd);
			}))
			.on(hcEvents.sendIce, proxy(function (tUserId, tConnId, connId, sd) {
				serverConnector.sendIce(tUserId, tConnId, connId, sd);
			}))
			.on(hcEvents.sendBye, proxy(function (tUserId, tConnId, connId) {
				serverConnector.sendBye(tUserId, tConnId, connId);
			}));

			connection.on(xrtc.Connection.events.connectionClosed, function () {
				connections.splice(getConnectionIndexById(connections, connectionId), 1);
				// todo: maybe need to unsubscribe this handshake controllers from all events
				delete handshakeControllers[connectionId];
			});

			connections.push(connection);

			self.trigger(xrtc.Room.events.connectionCreated, { userId: targetUserId, connection: connection });

			if (typeof connectionCreated === 'function') {
				connectionCreated({ connection: connection, handshakeController: hc });
			}
		}
	});

	xrtc.Room.extend({
		events: {
			enter: 'enter',
			leave: 'leave',

			incomingConnection: 'incomingconnection',
			connectionCreated: 'connectioncreated',
			connectionDeclined: 'connectiondeclined',

			receiveIce: 'receiveice',
			receiveOffer: 'receiveoffer',
			receiveAnswer: 'receiveanswer',
			receiveBye: 'receivebye',

			participantsUpdated: 'participantsupdated',
			participantConnected: 'participantconnected',
			participantDisconnected: 'participantdisconnected',
			tokenInvalid: 'tokeninvalid'
		},

		settings: {
			info: {
				domain: 'xirsys.com', //exports.document.domain,
				application: 'default',
				name: 'default'
			},

			options: {
				autoReply: true
			}
		}
	});
})(window);