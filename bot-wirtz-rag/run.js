// Wrapper: sets up fake stdin BEFORE loading bot
const { Readable } = require('stream');
const fakeStdin = new Readable({ read() {} });
fakeStdin.isTTY = true;
fakeStdin.setRawMode = () => {};
fakeStdin.resume = () => {};
Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

require('./index.js');
