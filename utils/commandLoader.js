/**
 * Command Loader - Separate module to avoid circular dependencies
 */

const fs = require('fs');
const path = require('path');

let _cachedCommands = null;
let _cacheTime = 0;
const CACHE_TTL = 60000;

const loadCommands = (forceReload = false) => {
  const now = Date.now();
  if (!forceReload && _cachedCommands && (now - _cacheTime < CACHE_TTL)) {
    return _cachedCommands;
  }

  const commands = new Map();
  const commandsPath = path.join(__dirname, '..', 'commands');
  
  if (!fs.existsSync(commandsPath)) {
    console.log('Commands directory not found');
    return commands;
  }
  
  const categories = fs.readdirSync(commandsPath);
  
  categories.forEach(category => {
    const categoryPath = path.join(commandsPath, category);
    if (fs.statSync(categoryPath).isDirectory()) {
      const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'));
      
      files.forEach(file => {
        const fullPath = path.join(categoryPath, file);
        try {
          if (forceReload) {
            delete require.cache[require.resolve(fullPath)];
          }
          const commandModule = require(fullPath);
          
          const { commands: cmdRegistry } = require('../command');
          
          let command = commandModule;
          
          const cmdName = command.pattern || command.name || command.command;
          if (cmdName) {
            commands.set(cmdName, command);
            const aliases = command.aliases || command.alias || [];
            if (Array.isArray(aliases)) {
              aliases.forEach(alias => commands.set(alias, command));
            } else if (typeof aliases === 'string') {
              commands.set(aliases, command);
            }
          }
          
          cmdRegistry.forEach((cmdObj, name) => {
            commands.set(name, cmdObj);
          });
          
        } catch (error) {
          console.error(`Error loading command ${file}:`, error.message);
        }
      });
    }
  });
  
  _cachedCommands = commands;
  _cacheTime = now;
  return commands;
};

module.exports = { loadCommands };
