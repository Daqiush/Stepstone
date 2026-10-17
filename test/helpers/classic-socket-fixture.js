'use strict';

const { SEATS } = require('../../classic/constants.cjs');

function createClassicSocketFixture() {
  const socketIds = Object.freeze({ N: 'socket-n', E: 'socket-e', S: 'socket-s', W: 'socket-w' });
  const emissions = [];
  const io = {
    to(target) {
      return {
        emit(name, payload) {
          emissions.push({ target, name, payload });
        },
      };
    },
  };
  return {
    io,
    emissions,
    socketIds,
    roomSockets: Object.fromEntries(SEATS.map(seat => [seat, socketIds[seat]])),
    clear() { emissions.length = 0; },
    forTarget(target) { return emissions.filter(emission => emission.target === target); },
    named(name) { return emissions.filter(emission => emission.name === name); },
  };
}

module.exports = { createClassicSocketFixture };
