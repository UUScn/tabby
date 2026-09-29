const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')
const { Subject } = require('rxjs')
const terminalRequire = createRequire(path.join(__dirname, '../tabby-terminal/package.json'))
const ZModem = terminalRequire('zmodem.js')

const root = path.join(__dirname, '..')
const tick = () => new Promise(resolve => setImmediate(resolve))

// Execute the production TypeScript with only Angular and platform UI replaced.
function load (file, mocks = {}, globals = {}) {
    const source = readFileSync(path.join(root, file), 'utf8')
    const result = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true, esModuleInterop: true },
        reportDiagnostics: true,
    })
    assert.equal(result.diagnostics.length, 0)
    const exports = {}
    vm.runInNewContext(result.outputText, {
        exports, Buffer, setTimeout, clearTimeout, ...globals,
        require: name => mocks[name] ?? require(name),
    }, { filename: file })
    return exports
}

const core = load('tabby-core/src/api/platform.ts')
const { SessionMiddleware } = load('tabby-terminal/src/api/middleware.ts', { 'tabby-core': core })
const { TerminalDecorator } = load('tabby-terminal/src/api/decorator.ts')

async function setup (response = 0) {
    let prompts = 0
    let pickers = 0
    let timeout
    const output = []
    const messages = []
    const platform = {
        showMessageBox: async () => { prompts++; return { response } },
        startUpload: async () => { pickers++; return [] },
    }
    const tokens = { ...core, LogService: Symbol('log'), TranslateService: Symbol('translate') }
    const injector = { runInContext: callback => callback() }
    const angular = {
        EnvironmentInjector: Symbol('injector'),
        Injectable: () => target => target,
        inject: token => {
            if (token === angular.EnvironmentInjector) return injector
            if (token === core.PlatformService) return platform
            if (token === tokens.TranslateService) return { instant: text => text }
            if (token === tokens.LogService) return { create: () => ({ info () {}, warn () {}, error () {} }) }
            throw new Error('Unexpected injection')
        },
    }
    const { ZModemDecorator } = load('tabby-terminal/src/features/zmodem.ts', {
        '@angular/core': angular,
        'tabby-core': tokens,
        'zmodem.js': ZModem,
        '../api/middleware': { SessionMiddleware },
        '../api/decorator': { TerminalDecorator },
        'ansi-colors': terminalRequire('ansi-colors'),
    }, {
        setTimeout: (callback, delay) => {
            if (delay === 15000) { timeout = callback; return 1 }
            return setTimeout(callback, delay)
        },
        clearTimeout: () => { timeout = undefined },
    })
    let middleware
    const newSession = () => ({
        open: true,
        middleware: { unshift: value => {
            middleware = value
            value.outputToSession$.subscribe(data => output.push(data))
            value.outputToTerminal$.subscribe(data => messages.push(data.toString()))
        } },
    })
    const terminal = {
        session: newSession(),
        sessionChanged$: new Subject(),
        frontend: { dragOver$: new Subject(), drop$: new Subject(), focus () {} },
    }
    const decorator = new ZModemDecorator()
    decorator.attach(terminal)
    await new Promise(resolve => setTimeout(resolve, 0))
    return {
        terminal, output, messages, newSession,
        get middleware () { return middleware },
        get prompts () { return prompts },
        get pickers () { return pickers },
        get timeout () { return timeout },
        drop: (files, directory = false) => {
            let prevented = false
            terminal.frontend.drop$.next({
                preventDefault: () => { prevented = true },
                dataTransfer: { files, items: files.map(() => ({ webkitGetAsEntry: () => ({ isDirectory: directory }) })) },
            })
            assert.ok(prevented)
        },
        close: () => { middleware.close(); decorator.detach(terminal) },
    }
}

test('drop runs rz and transfers multiple files, binary data and an empty file without dialogs', { timeout: 5000 }, async () => {
    const f = await setup()
    try {
        const files = [new File([Uint8Array.from({ length: 140000 }, (_, i) => i % 256)], '中文 file.bin'), new File([], 'empty.txt')]
        f.drop(files)
        assert.equal(Buffer.concat(f.output).toString(), 'rz\r')
        const receiver = new ZModem.Session.Receive()
        const received = []
        const completed = new Promise(resolve => receiver.on('session_end', resolve))
        receiver.on('offer', offer => {
            const entry = { name: offer.get_details().name, chunks: [] }
            received.push(entry)
            offer.accept({ on_input: bytes => entry.chunks.push(Buffer.from(bytes)) })
        })
        receiver.set_sender(bytes => setImmediate(() => f.middleware.feedFromSession(Buffer.from(bytes))))
        f.middleware.outputToSession$.subscribe(bytes => setImmediate(() => receiver.consume(Array.from(bytes))))
        receiver.start()
        await completed
        await tick()
        assert.equal(f.prompts, 0)
        assert.equal(f.pickers, 0)
        assert.equal(f.timeout, undefined)
        assert.deepEqual(received.map(x => x.name), files.map(x => x.name))
        for (let i = 0; i < files.length; i++) {
            assert.deepEqual(Buffer.concat(received[i].chunks), Buffer.from(await files[i].arrayBuffer()))
        }
        assert.ok(f.messages.join('').includes('Complete'))
    } finally { f.close() }
})

test('duplicate drops, directories, empty drops and disconnected sessions do not start uploads', async () => {
    const f = await setup()
    try {
        const files = [new File(['hello'], 'file.txt')]
        f.drop([])
        f.drop(files, true)
        f.terminal.session.open = false
        f.drop(files)
        assert.equal(f.output.length, 0)
        f.terminal.session.open = true
        f.drop(files)
        f.drop([new File(['other'], 'other.txt')])
        assert.equal(Buffer.concat(f.output).toString(), 'rz\r')
    } finally { f.close() }
})

test('timeout, Ctrl+C and session teardown clear pending uploads', async () => {
    const f = await setup()
    try {
        const files = [new File(['hello'], 'file.txt')]
        f.drop(files)
        f.timeout()
        assert.ok(f.messages.join('').includes('timed out'))
        f.drop(files)
        f.middleware.feedFromTerminal(Buffer.from([3]))
        assert.equal(f.timeout, undefined)
        f.drop(files)
        assert.equal(Buffer.concat(f.output).toString(), 'rz\rrz\r\x03rz\r')
        f.middleware.close()
        assert.equal(f.timeout, undefined)
        f.terminal.session = f.newSession()
        f.terminal.sessionChanged$.next(f.terminal.session)
        f.drop(files)
        assert.equal(f.output.at(-1).toString(), 'rz\r')
    } finally { f.close() }
})

test('manual rz still asks for confirmation and opens the file picker', { timeout: 5000 }, async () => {
    const f = await setup()
    try {
        const receiver = new ZModem.Session.Receive()
        const completed = new Promise(resolve => receiver.on('session_end', resolve))
        receiver.set_sender(bytes => setImmediate(() => f.middleware.feedFromSession(Buffer.from(bytes))))
        f.middleware.outputToSession$.subscribe(bytes => setImmediate(() => receiver.consume(Array.from(bytes))))
        receiver.start()
        await completed
        assert.equal(f.prompts, 1)
        assert.equal(f.pickers, 1)
    } finally { f.close() }
})

test('a late handshake after timeout does not upload stale dropped files', { timeout: 5000 }, async () => {
    const f = await setup()
    try {
        f.drop([new File(['private'], 'stale.txt')])
        f.timeout()
        const receiver = new ZModem.Session.Receive()
        const completed = new Promise(resolve => receiver.on('session_end', resolve))
        receiver.on('offer', () => assert.fail('Timed-out files must not be offered'))
        receiver.set_sender(bytes => setImmediate(() => f.middleware.feedFromSession(Buffer.from(bytes))))
        f.middleware.outputToSession$.subscribe(bytes => setImmediate(() => receiver.consume(Array.from(bytes))))
        receiver.start()
        await completed
        assert.equal(f.prompts, 1)
        assert.equal(f.pickers, 1)
    } finally { f.close() }
})

test('an unsolicited session can still be rejected without opening a picker', async () => {
    const f = await setup(1)
    try {
        const receiver = new ZModem.Session.Receive()
        receiver.set_sender(bytes => f.middleware.feedFromSession(Buffer.from(bytes)))
        receiver.start()
        await tick()
        assert.equal(f.prompts, 1)
        assert.equal(f.pickers, 0)
        assert.equal(f.output.length, 0)
    } finally { f.close() }
})
