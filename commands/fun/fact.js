module.exports = {
  name: 'fact',
  aliases: ['facts', 'funfact', 'randomfact'],
  category: 'fun',
  description: 'Get a random fun fact',
  usage: '.fact',

  async execute(sock, msg, args, extra) {
    try {
      const facts = [
        "Honey never spoils. Archaeologists have found 3,000-year-old honey in Egyptian tombs that was still edible.",
        "Octopuses have three hearts and blue blood.",
        "A group of flamingos is called a 'flamboyance.'",
        "Bananas are berries, but strawberries aren't.",
        "The Eiffel Tower can grow up to 6 inches taller during summer due to heat expansion.",
        "A day on Venus is longer than a year on Venus.",
        "Cows have best friends and get stressed when separated.",
        "The shortest war in history lasted 38 to 45 minutes between Britain and Zanzibar.",
        "There are more possible iterations of a game of chess than atoms in the known universe.",
        "A bolt of lightning is five times hotter than the surface of the sun.",
        "Scotland's national animal is the unicorn.",
        "There are more trees on Earth than stars in the Milky Way.",
        "An octopus has nine brains — one central brain and one in each arm.",
        "The inventor of the Pringles can is buried in one.",
        "Sharks are older than trees. Sharks have been around for about 400 million years.",
        "A sneeze travels at about 100 miles per hour.",
        "The average person walks about 100,000 miles in a lifetime — that's 4 times around the Earth.",
        "Cats can't taste sweetness.",
        "The moon has moonquakes, similar to earthquakes on Earth.",
        "Humans share about 60% of their DNA with bananas.",
        "A cloud can weigh more than a million pounds.",
        "Cleopatra lived closer in time to the moon landing than to the construction of the Great Pyramid.",
        "The heart of a blue whale is so big that a small child could swim through its arteries.",
        "Water can boil and freeze at the same time under specific conditions (triple point).",
        "There's enough DNA in the average person's body to stretch from the sun to Pluto 17 times."
      ];

      const fact = facts[Math.floor(Math.random() * facts.length)];

      await extra.react('🧠');

      const text = `╭━━〔 🧠 FUN FACT 〕━━⬣
┃
┃ 📖 ${fact}
┃
╰━━━━━━━━━━━━━━━━━━━━⬣

> *INFINITY MD*`;

      await extra.reply(text);
    } catch (error) {
      await extra.reply(`❌ Error: ${error.message}`);
    }
  }
};
