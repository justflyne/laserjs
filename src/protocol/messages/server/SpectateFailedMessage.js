'use strict';

function decode(reader, fields) { fields.reason = reader.vint(); }

module.exports = { name: 'SpectateFailedMessage', messageType: 24105, messageVersion: 0,
    direction: 'server', decode };
