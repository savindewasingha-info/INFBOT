/**
 * Command Definition System
 * This allows commands to be defined using cmd({ ... }, async (...) => { ... })
 * to maintain compatibility with different command styles in the project.
 */

if (!global.cmdRegistry) {
    global.cmdRegistry = new Map();
}

let _filterCounter = 0;

function cmd(info, handler) {
    const command = {
        ...info,
        handler: handler
    };
    
    const name = info.pattern || info.name || info.command;
    if (name) {
        global.cmdRegistry.set(name, command);
        if (info.alias) {
            const aliases = Array.isArray(info.alias) ? info.alias : [info.alias];
            aliases.forEach(a => global.cmdRegistry.set(a, command));
        }
        if (info.aliases) {
            const aliases = Array.isArray(info.aliases) ? info.aliases : [info.aliases];
            aliases.forEach(a => global.cmdRegistry.set(a, command));
        }
    } else if (typeof info.filter === 'function') {
        // Filter-only commands (multi-step flows) — store with a unique key
        global.cmdRegistry.set(`__filter_${_filterCounter++}`, command);
    }
    return command;
}

module.exports = { cmd, commands: global.cmdRegistry };
