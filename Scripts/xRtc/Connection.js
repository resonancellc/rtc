﻿'use strict';

(function (exports) {
	var getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia,
		URL = exports.URL || exports.webkitURL || exports.msURL || exports.oURL,
		RTCPeerConnection = exports.PeerConnection || exports.webkitPeerConnection00 || exports.webkitRTCPeerConnection,
		RTCIceCandidate = exports.RTCIceCandidate,
		RTCSessionDescription = exports.RTCSessionDescription;

	// todo: move to another place
	function extend(destinationObj, sourceObj) {
		for (var i in sourceObj) {
			destinationObj[i] = sourceObj[i];
		}
	}

	var xrtc = exports.xRtc;
	xrtc.Connection = new xrtc.Class('Connection');

	xrtc.Connection.include(xrtc.EventDispatcher);
	xrtc.Connection.include({
		init: function (userData, handshakeController) {
			var self = this;
			self._logger = new xrtc.Logger();
			self._peerConnection = null;
			self._remoteParticipant = null;
			self._handshakeController = handshakeController;
			self._userData = userData;
			self._localStreams = [];

			handshakeController.on(xrtc.HandshakeController.events.receiveIce, function (response) {
				self._initPeerConnection(response.senderId, function (peerConnection) {
					self._logger.debug('Connection.receiveIce', response);

					var iceCandidate = new RTCIceCandidate(response.iceCandidate);
					//var iceCandidate = new RTCIceCandidate(JSON.parse(response.iceCandidate));
					peerConnection.addIceCandidate(iceCandidate);

					self.trigger(xrtc.Connection.events.iceAdded, response, iceCandidate);
				});
			});
			
			handshakeController.on(xrtc.HandshakeController.events.receiveOffer, function (response) {
				self._initPeerConnection(response.senderId, function (peerConnection) {
					self._logger.debug('Connection.receiveOffer', response);
					var sdp = JSON.parse(response.sdp);

					// todo: remove it
					self._remoteParticipant = response.senderId;
					if (response.receiverId !== self._userData.name) {
						return;
					}
					// todo: remove it

					var sessionDescription = new RTCSessionDescription(sdp);
					
					peerConnection.setRemoteDescription(sessionDescription);
					
					peerConnection.createAnswer(
						function (answer) {
							peerConnection.setLocalDescription(answer);
							
							self._handshakeController.sendAnswer(response.senderId, JSON.stringify(answer));

							self._logger.debug('Connection.sendAnswer', response, answer);
							self.trigger(xrtc.Connection.events.answerSent, response, answer);

							/***********************************************/
							// todo: check and refactor
							//peerConnection.onaddstream = function (stream) {
							var stream = self._peerConnection.remoteStreams[0],
								data = {
									stream: stream,
									url: URL.createObjectURL(stream),
									isLocal: false,
									participantId: self._remoteParticipant
								};

								self.trigger(xrtc.Connection.events.streamAdded, data);
								self.trigger(xrtc.Connection.events.connectionEstablished, data);
							//};

							/***********************************************/
						},
						function (error) {
							var data = { error: error };
							self._logger.error('Connection.sendAnswer', data);
							self.trigger(xrtc.Connection.events.answerError, data);
						},
						xrtc.Connection.settings.answerOptions);
				});
			});

			handshakeController.on(xrtc.HandshakeController.events.receiveAnswer, function (response) {
				self._initPeerConnection(response.senderId, function (peerConnection) {
					self._logger.debug('Connection.receiveAnswer', response);
					var sdp = JSON.parse(response.sdp);

					var sessionDescription = new RTCSessionDescription(sdp);
					peerConnection.setRemoteDescription(sessionDescription);
					self.trigger(xrtc.Connection.events.answerReceived, response, sessionDescription);


					/***********************************************/
					// todo: think to refactor this
					var stream = peerConnection.remoteStreams[0],
						data = {
							stream: stream,
							url: URL.createObjectURL(stream),
							isLocal: false,
							participantId: self._remoteParticipant
						};
					self.trigger(xrtc.Connection.events.streamAdded, data);
					self.trigger(xrtc.Connection.events.connectionEstablished, data);
					/***********************************************/
				});
			});
		},

		connect: function () {
			var self = this;

			this._getToken(function (token) {
				self._getIceServersByToken(token, function (iceServers) {
					self._iceServers = iceServers;
					self._handshakeController.connect(token);
				});
			});
		},

		startSession: function (participantId, options) {
			var self = this, opts = {};

			extend(opts, xrtc.Connection.settings.offerOptions);
			extend(opts, options || {});

			this._initPeerConnection(participantId, function (peerConnection) {
				peerConnection.createOffer(
					function (offer) {
						peerConnection.setLocalDescription(offer);
						self._logger.debug('Connection.sendOffer', self._remoteParticipant, offer);
						self._handshakeController.sendOffer(self._remoteParticipant, JSON.stringify(offer));
						
						self.trigger(xrtc.Connection.events.offerSent, self._remoteParticipant, offer);
					},
					function (error) {
						var data = { error: error };
						self._logger.error('Connection.sendOffer', data);
						self.trigger(xrtc.Connection.events.offerError, data);
					},
					opts
				);
			});
		},

		endSession: function () {
			if (this._peerConnection) {
				this._peerConnection.close();
			}
		},

		addMedia: function (options) {
			var self = this, opts = {};

			extend(opts, xrtc.Connection.settings.mediaOptions);
			extend(opts, options || {});

			getUserMedia.call(navigator, opts,
				function (stream) {
					var data = {
						stream: stream,
						url: URL.createObjectURL(stream),
						isLocal: true, //stream.constructor.name === 'LocalMediaStream'
						participantId: self._userData.name
					};

					self._localStreams.push(stream);

					self.trigger(xrtc.Connection.events.streamAdded, data);
				},
				function (error) {
					var data = {
						error: error
					};

					self.trigger(xrtc.Connection.events.streamError, data);
				});
		},

		createDataChannel: function (name) {
			// todo: check negative flows
			var dataChannel = null;

			try {
				dataChannel = new xrtc.DataChannel(this._peerConnection.createDataChannel(name, { reliable: false }), this._remoteParticipant);
			} catch(ex) {
				var error = {
					exception: ex
				};
				this.trigger(xrtc.Connection.events.dataChannelCreationError, error);
			}

			return dataChannel;
		},

		_getToken: function (callback) {
			var self = this,
				ajax = new xrtc.Ajax();

			ajax.request(
				xrtc.Connection.settings.URL + 'getToken',
				xrtc.Ajax.methods.POST,
				'data=' + JSON.stringify(this._getTokenRequestParams()),
				function (response) {

					//todo: remove try/catch. say Lee to fix empty response
					try {
						self._logger.debug('Connection._getToken', response);

						var serverMessage = JSON.parse(response.responseText);
						if (!!serverMessage && !!serverMessage.E && serverMessage.E != '') {
							var errorData = { method: 'getToken', error: serverMessage.E };
							self._logger.error('Connection._getToken', errorData);
							self.trigger(xrtc.Connection.events.serverError, errorData);
							return;
						}

						var token = serverMessage.D.token;
						self._logger.info('Connection._getToken', token);

						if (typeof (callback) == 'function') {
							callback.call(self, token);
						}
					} catch (e) {
						self._getToken(callback);
					}
					//todo: remove try/catch
				}
			);
		},

		_getIceServers: function (callback) {
			var self = this;

			if (this._iceServers) {
				if (typeof(callback) == 'function') {
					callback.call(this, this._iceServers);
				}
			} else {
				self._getToken(function(token) {
					self._getIceServersByToken(token, callback);
				});
			}
		},

		_getIceServersByToken: function (token, callback) {
			if (this._iceServers) {
				if (typeof(callback) == 'function') {
					callback.call(this, this._iceServers);
				}
			} else {
				var self = this,
					ajax = new xrtc.Ajax();

				ajax.request(
					xrtc.Connection.settings.URL + 'getIceServers',
					xrtc.Ajax.methods.POST,
					'token=' + token,
					function(response) {
						//todo: remove try/catch. say Lee to fix empty response
						try {
							self._logger.debug('Connection._getIceServers', response);

							var serverMessage = JSON.parse(response.responseText);
							if (!!serverMessage && !!serverMessage.E && serverMessage.E != '') {
								var errorData = { method: 'getIceServers', error: serverMessage.E };
								self._logger.error('Connection._getIceServers', errorData);
								self.trigger(xrtc.Connection.events.serverError, errorData);
								return;
							}

							// todo: say Lee to fix iceServers message format and remove replacement
							var iceServers = JSON.parse(serverMessage.D);
							self._logger.info('Connection._getIceServers', iceServers);

							if (typeof(callback) == 'function') {
								callback.call(self, iceServers);
							}

						} catch(e) {
							self._getIceServersByToken(token, callback);
						}
					}
				);
			}
		},

		_initPeerConnection: function (participant, callback) {
			this._remoteParticipant = participant;
			var self = this;

			function callCallback() {
				if (typeof callback === "function") {
					try {
						callback(self._peerConnection);
					} catch (e) {
						console.error(e);
					}
				}
			}

			if (!this._peerConnection) {
				this._getIceServers(function (iceServers) {
					self._peerConnection = new RTCPeerConnection(iceServers, xrtc.Connection.settings.peerConnectionOptions);
					self._logger.info('Connection._initPeerConnection', 'PeerConnection created.');
					self.trigger(xrtc.Connection.events.peerConnectionCreation);

					self._peerConnection.onicecandidate = function (evt) {
						if (!!evt.candidate) {
							self._handshakeController.sendIce(self._remoteParticipant, evt.candidate);
							self.trigger(xrtc.Connection.events.iceSent, { event: evt });
						}
					};
					
					for (var i = 0, len = self._localStreams.length; i < len; i++) {
						this._peerConnection.addStream(self._localStreams[i]);
					}

					callCallback();
				});
			} else {
				callCallback();
			}
		},

		_getTokenRequestParams: function () {
			var tokenParams = xrtc.Connection.settings.tokenParams,
				userData = this._userData,
				result = {
					Type: tokenParams.type,
					Authentication: tokenParams.authentication,
					Authorization: tokenParams.authorization,
					Domain: userData.domain,
					Application: userData.application,
					Room: userData.room,
					Ident: userData.name
				};

			this._logger.info('Connection._getTokenRequestParams', result);

			return result;
		}
	});

	xrtc.Connection.extend({
		events: {
			streamAdded: 'streamadded',
			streamError: 'streamerror',

			iceAdded: 'iceadded',
			iceSent: 'icesent',

			offerSent: 'offersent',
			offerError: 'offererror',

			answerSent: 'answersent',
			answerReceived: 'answerreceived',
			answerError: 'answererror',

			dataChannelCreationError: 'datachannelcreationerror',

			serverError: 'servererror',
			
			connectionEstablished: 'connectionestablished',
			
			peerConnectionCreation: 'peerconnectioncreation'
		},

		settings: {
			URL: 'http://turn.influxis.com/',

			tokenParams: {
				type: 'token_request',
				authentication: 'public',
				authorization: null,
			},

			offerOptions: {
				mandatory: {
					OfferToReceiveAudio: true,
					OfferToReceiveVideo: true
				}
			},

			answerOptions: {
				mandatory: {
					OfferToReceiveAudio: true,
					OfferToReceiveVideo: true
				}
			},

			mediaOptions: {
				audio: true,
				video: {
					mandatory: { minAspectRatio: 1.333, maxAspectRatio: 1.334 },
					optional: [{ minFrameRate: 24 }, { maxWidth: 300 }, { maxHeigth: 300 }]
				}
			},

			peerConnectionOptions: {
				optional: [{ RtpDataChannels: true }]
			}
		}
	});
})(window);