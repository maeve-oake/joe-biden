import { read } from 'fs';
import { createRequire } from 'module';
import { machine } from 'os';
const require = createRequire(import.meta.url);

var lock = false; // lock input until LLM is finished, stops crosstalk.

import { io } from "socket.io-client";

let { Client: DiscordClient, MessageManager, Message, MessageEmbed, MessageAttachment } = require('discord.js-12'),
    { config: loadEnv } = require('dotenv')

loadEnv()

let config = {
    bot_uid: 0,                     // bot UID will be added on login
    supply_date: false,             // whether the prompt supplies the date & time
    reply_depth: 4,                 // how many replies deep to add to the prompt - higher = slower
    model: "alpaca.7B"              // which AI model to use
}

let client = new DiscordClient();
let delay = ms => new Promise(res => setTimeout(res, ms));

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);

    config.bot_uid = client.user.id;

    let guilds = client.guilds.cache.map(guild => guild);
    console.log(`The bot is in ${guilds.length} guilds`);
});

client.on('guildCreate', async guild => {
    console.log("\x1b[32m", `Joined new guild: ${guild.name}`)
})

client.on('guildDelete', async guild => {
    console.log("\x1b[31m", `Kicked from Guild: ${guild.name}`)
})

await client.on('message', async message => {
    if (!message.guild || message.author.bot) { return };

    if (lock) { return }

    var users = message.mentions.users // get mentioned users

    if (users == undefined || users == null) { return; } // return if no mentions - works for reply and ping

    var bot_mentioned = false

    users.forEach(user => {
        if (user.id == config.bot_uid) { bot_mentioned = true }
    })

    if (!bot_mentioned) { return }

    console.log("\x1b[32mBot mentioned - Generating prompt...\x1b[0m\n")

    lock = true // lock input until LLM has returned

    var request = {
        seed: -1,
        threads: 10,
        n_predict: 200,
        top_k: 40,
        top_p: 0.9,
        temp: 0.8,
        repeat_last_n: 64,
        repeat_penalty: 1.1,
        debug: false,
        models: [config.model],
        prompt: await generatePrompt(message)
    }

    var socket = io("ws://127.0.0.1:3000"); // connect to LLM

    message.channel.startTyping();
    socket.emit("request", request);

    var response = "";
    var fullresponse = ""

    console.log("\n\x1b[32mGenerating response...\x1b[0m")

    socket.on("result", result => {
        response += result.response;
        fullresponse += result.response;

        if (!message.deletable) // stops bot from crashing if the message was deleted
        {
            console.log("\x1b[41m\nOriginal message was deleted.\x1b[0m")

            var stoprequest = {
                prompt: "/stop"
            }

            socket.emit("request", stoprequest);
            message.channel.stopTyping()
            socket.disconnect()
            lock = false
        }

        else if (response.endsWith("<end>")) {
            response = response.replace(/[\r]/gm, "")
            response = response.replace("\$", "\\$")
            response = response.substring(response.length, request.prompt.length).trim()
            response = response.replace("<end>", "").trim()
            response = response.replace("[end of text", "").trim()

            client.api.channels[message.channel.id].messages.post({
                data: {
                    content: response,
                    message_reference: {
                        message_id: message.id,
                        channel_id: message.channel.id,
                        guild_id: message.guild.id
                    }
                }
            }).then(() => {
                console.log("\n\x1b[44m// RESPONSE //\x1b[0m")
                console.log(response)
                console.log("\x1b[44m// END OF RESPONSE //\x1b[0m\n")
                message.channel.stopTyping()
                socket.disconnect()
                lock = false
            })
        }
    })
})

async function GetReplyStack(message, depth, stack) {
    var ref = message.reference;

    console.log("DEPTH:" + depth)
    if (ref == undefined || ref == null || depth <= 1) { return stack }

    var repliedTo = await message.channel.messages.fetch(ref.messageID);

    var name = repliedTo.author.username
    var content = repliedTo.content

    stack = `${name}: ${content}\n` + stack
    depth--;

    return GetReplyStack(repliedTo, depth, stack)
}

async function replaceUsernames(input) {
    var regex = /<@[0-9]+>/g;
    var matches = input.match(regex)

    if (matches == undefined || matches == null) { return input }

    matches.forEach(uid => {
        var id = uid.replace(/[^0-9.]/g, '')
        var user = client.users.cache.find(user => user.id == id)

        if (user == undefined || user == null) { return }

        input = input.replaceAll(uid, user.username)
    })

    return input;
}

async function generatePrompt(message) {

    let stack = ""
    stack = await GetReplyStack(message, config.reply_depth, stack)
    stack += `${message.author.username}: ${message.content}\n`
    stack = await replaceUsernames(stack)
    stack = stack.replaceAll(`<@${config.bot_uid}>`, "").trim()
    //stack = stack.replaceAll("`", "").trim()
    //stack = stack.replaceAll("$", `\\$`)
    //stack = stack.replaceAll("{", "(").replaceAll("}", ")")

    var input = `You are the President of the United States, Joe Biden.
You must reply in-character, to any questions asked by your Citizens.
Refer to your Citizens by name, with consise answers.
${stack}
joe biden: `

    console.log("\x1b[41m// PROMPT GENERATED //\x1b[0m")
    console.log(input)
    console.log("\x1b[41m// END OF PROMPT //\x1b[0m")

    return input;
}

let [arg] = process.argv.slice(2);
let token = process.env.BOT_TOKEN;
if (arg == "dev") { token = process.env.DEV_TOKEN }
client.login(token);
