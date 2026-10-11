'use strict';

function createUnknownMessage(messageType) {
    return { name: `UnknownMessage(${messageType})`, messageType, messageVersion: 0,
        direction: 'unknown', decode(_reader, fields) { fields.decoded = false; } };
}

module.exports = { createUnknownMessage };
