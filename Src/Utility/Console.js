function log(event, error) {
    // Error messages, stacks, and request payloads can contain authorization headers or URLs.
    const code = typeof error?.code === 'number' ? ` (code ${error.code})` : '';
    (error ? console.error : console.log)(`[Hydra] ${event}${code}`);
}

module.exports = { log };
