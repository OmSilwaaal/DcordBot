import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type SendableChannels,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../config.js';
import type { Notifier } from '../signals/engine.js';
import type { PerformanceTracker } from '../signals/performance.js';
import type { SignalRecord } from '../types.js';
import { log } from '../utils/logger.js';
import { clean, filtersEmbed, resultLine, signalEmbed, statsEmbed } from './format.js';

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Forward-tested signal performance')
    .addIntegerOption((o) => o.setName('hours').setDescription('Lookback (default 24)').setMinValue(1).setMaxValue(720)),
  new SlashCommandBuilder().setName('recent').setDescription('Last 10 signals and how they did'),
  new SlashCommandBuilder().setName('filters').setDescription('Current filter thresholds and trade plan'),
].map((c) => c.toJSON());

export class DiscordNotifier implements Notifier {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds] });
  private channel: SendableChannels | null = null;

  constructor(private readonly perf: PerformanceTracker) {}

  async start(): Promise<void> {
    const { token, channelId } = config.discord;
    if (!token || !channelId) throw new Error('DISCORD_TOKEN and DISCORD_CHANNEL_ID are required');

    this.client.on(Events.InteractionCreate, (i) => {
      if (i.isChatInputCommand()) void this.handle(i);
    });
    const ready = new Promise<void>((res) => this.client.once(Events.ClientReady, () => res()));
    await this.client.login(token);
    await ready;
    log.info(`[discord] logged in as ${this.client.user?.tag}`);

    const ch = await this.client.channels.fetch(channelId);
    if (!ch || !ch.isSendable()) throw new Error(`Channel ${channelId} not found or bot can't send there`);
    this.channel = ch;
    await this.registerCommands();
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async sendSignal(r: SignalRecord): Promise<string | null> {
    if (!this.channel) return null;
    const msg = await this.channel.send({ embeds: [signalEmbed(r)] });
    return msg.id;
  }

  /** Edits the original alert with its forward-tested result once tracking ends. */
  async updateSignal(r: SignalRecord): Promise<void> {
    if (!this.channel || !r.messageId || !('messages' in this.channel)) return;
    try {
      const msg = await this.channel.messages.fetch(r.messageId);
      await msg.edit({ embeds: [signalEmbed(r)] });
    } catch (e) {
      log.warn(`[discord] could not update result for ${r.symbol}`, e);
    }
  }

  private async registerCommands(): Promise<void> {
    try {
      if (config.discord.guildId) {
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        await guild.commands.set(COMMANDS);
      } else {
        await this.client.application?.commands.set(COMMANDS);
      }
      log.info('[discord] slash commands registered');
    } catch (e) {
      log.warn('[discord] slash command registration failed (needs applications.commands scope)', e);
    }
  }

  private async handle(i: ChatInputCommandInteraction): Promise<void> {
    try {
      if (i.commandName === 'stats') {
        const hours = i.options.getInteger('hours') ?? 24;
        await i.reply({ embeds: [statsEmbed(this.perf.summary(hours), hours)] });
      } else if (i.commandName === 'recent') {
        const all = [...this.perf.finished(), ...this.perf.active.values()]
          .sort((a, b) => b.signaledAt - a.signaledAt)
          .slice(0, 10);
        const lines = all.map((r) => {
          const res = r.finalizedAt ? resultLine(r).split('\n').pop() : `live · now ${r.perf.lastMult.toFixed(2)}×`;
          return `**$${clean(r.symbol, 16)}** · ${r.tier}${r.score} · <t:${Math.floor(r.signaledAt / 1000)}:R> · ${res}`;
        });
        await i.reply({ content: lines.join('\n') || 'No signals yet.', allowedMentions: { parse: [] } });
      } else if (i.commandName === 'filters') {
        await i.reply({ embeds: [filtersEmbed()] });
      }
    } catch (e) {
      log.warn(`[discord] /${i.commandName} failed`, e);
    }
  }
}
