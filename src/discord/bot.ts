import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type SendableChannels,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../config.js';
import type { Notifier } from '../signals/engine.js';
import type { PerformanceTracker } from '../signals/performance.js';
import type { SignalRecord } from '../types.js';
import { log } from '../utils/logger.js';
import type { DiagReport } from '../signals/diagnostics.js';
import type { SignalEngine } from '../signals/engine.js';
import { buildExport } from './export.js';
import { breakEvenSpread } from '../skins/fees.js';
import { dealEmbed, type SkinScanner } from '../skins/scanner.js';
import {
  clean,
  filtersEmbed,
  funnelEmbed,
  resultLine,
  signalEmbed,
  statsEmbed,
  statusEmbed,
  testSignalEmbed,
} from './format.js';

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Forward-tested signal performance')
    .addIntegerOption((o) => o.setName('hours').setDescription('Lookback (default 24)').setMinValue(1).setMaxValue(720)),
  new SlashCommandBuilder().setName('recent').setDescription('Last 10 signals and how they did'),
  new SlashCommandBuilder().setName('filters').setDescription('Current filter thresholds and trade plan'),
  new SlashCommandBuilder().setName('status').setDescription('Live self-test: feed, RPC, APIs, storage, closest candidates'),
  new SlashCommandBuilder().setName('funnel').setDescription('Where tokens are getting filtered out, and which gate blocks the most'),
  new SlashCommandBuilder().setName('test').setDescription('Post a clearly-labelled fake signal to the signals channel'),
].map((c) => c.toJSON());

const EXPORT_COMMAND = new SlashCommandBuilder()
  .setName('export')
  .setDescription('Owner only: attach the bot data logs (signals, dataset) as gzip files')
  .toJSON();

const SKIN_COMMANDS = [
  new SlashCommandBuilder()
    .setName('deals')
    .setDescription('Current CS2 deals found by the last Skinport scan')
    .addNumberOption((o) => o.setName('min_edge').setDescription('Minimum net edge in % (default: alert threshold)').setMinValue(0).setMaxValue(200)),
  new SlashCommandBuilder().setName('skinstatus').setDescription('Skin scanner health: last scan, fees, thresholds'),
].map((c) => c.toJSON());

export class DiscordNotifier implements Notifier {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds] });
  private channel: SendableChannels | null = null;
  private diagnostics: (() => Promise<DiagReport>) | null = null;
  private engine: SignalEngine | null = null;
  private skins: SkinScanner | null = null;
  skinChannel: SendableChannels | null = null;

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

    // Log which servers the bot is actually in — the #1 cause of "Missing Access" is the bot never joining.
    const guilds = [...this.client.guilds.cache.values()];
    log.info(
      `[discord] bot is in ${guilds.length} server(s)` +
        (guilds.length ? `: ${guilds.map((g) => `${g.name} (${g.id})`).join(', ')}` : ' — it was never invited'),
    );

    let ch;
    try {
      ch = await this.client.channels.fetch(channelId);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 50001)
        throw new Error(
          `Missing Access to channel ${channelId}. Either the bot isn't in the server that owns this channel ` +
            `(invite it with the "bot" scope), the ID is wrong (group DMs and channels in other servers won't work), ` +
            `or the channel is private and the bot has no View Channel permission there.`,
        );
      if (code === 10003) throw new Error(`Unknown Channel ${channelId}: that ID isn't a channel. Right-click the channel → Copy Channel ID.`);
      throw e;
    }
    if (!ch || !ch.isSendable()) throw new Error(`Channel ${channelId} is not a text channel the bot can send to`);
    if ('guild' in ch && ch.guild && 'permissionsFor' in ch) {
      const perms = ch.permissionsFor(this.client.user!);
      const need = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'] as const;
      const missing = need.filter((p) => !perms?.has(p));
      if (missing.length) throw new Error(`Bot can see #${ch.name} but is missing permissions: ${missing.join(', ')}`);
    }
    this.channel = ch;
    await this.resolveSkinChannel();
    await this.registerCommands();
    if (config.discord.startupMessage) {
      await ch
        .send('🟢 **Memecoin radar online** — watching pump.fun launches. Run `/status` for a live self-test.')
        .catch((e) => log.warn('[discord] startup message failed', e));
    }
  }

  /** Wired up in index.ts once the engine exists. */
  setDiagnostics(fn: () => Promise<DiagReport>, engine: SignalEngine): void {
    this.diagnostics = fn;
    this.engine = engine;
  }

  setSkins(scanner: SkinScanner): void {
    this.skins = scanner;
  }

  /** Optional: skin alerts go to their own channel. A bad ID disables skin alerts, never the signal bot. */
  private async resolveSkinChannel(): Promise<void> {
    const { enabled, channelId } = config.skins;
    if (!enabled) return;
    try {
      const ch = channelId ? await this.client.channels.fetch(channelId) : null;
      if (!ch || !ch.isSendable()) throw new Error(`SKINS_CHANNEL_ID ${channelId || '(unset)'} is not a sendable text channel`);
      this.skinChannel = ch;
    } catch (e) {
      log.warn('[skins] channel unavailable, skin alerts will be logged only', e);
    }
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

  private commands() {
    return [
      ...COMMANDS,
      ...(config.skins.enabled ? SKIN_COMMANDS : []),
      ...(config.discord.ownerId ? [EXPORT_COMMAND] : []),
    ];
  }

  private async registerCommands(): Promise<void> {
    try {
      if (config.discord.guildId) {
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        await guild.commands.set(this.commands());
      } else {
        await this.client.application?.commands.set(this.commands());
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
      } else if (i.commandName === 'status') {
        if (!this.diagnostics) {
          await i.reply({ content: 'Still starting up — try again in a few seconds.', flags: MessageFlags.Ephemeral });
          return;
        }
        await i.deferReply(); // live checks can take ~10s; Discord needs an ack within 3s
        await i.editReply({ embeds: [statusEmbed(await this.diagnostics())] });
      } else if (i.commandName === 'funnel') {
        if (!this.engine) {
          await i.reply({ content: 'Still starting up — try again in a few seconds.', flags: MessageFlags.Ephemeral });
          return;
        }
        await i.reply({ embeds: [funnelEmbed(this.engine.funnelReport())] });
      } else if (i.commandName === 'export') {
        // Trading data stays private: owner only, reply visible only to them.
        if (!config.discord.ownerId || i.user.id !== config.discord.ownerId) {
          await i.reply({ content: 'Not allowed.', flags: MessageFlags.Ephemeral });
          return;
        }
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const { files, summary } = buildExport();
        await i.editReply({ content: summary, files });
      } else if (i.commandName === 'deals') {
        if (!this.skins) {
          await i.reply({ content: 'Skin scanner is not enabled (SKINS_ENABLED=true).', flags: MessageFlags.Ephemeral });
          return;
        }
        const min = (i.options.getNumber('min_edge') ?? config.skins.minNetEdge * 100) / 100;
        const deals = this.skins.lastDeals.filter((d) => d.edge >= min).slice(0, 5);
        if (!deals.length) {
          await i.reply({ content: `No deals at ≥${(min * 100).toFixed(1)}% net edge in the last scan.`, flags: MessageFlags.Ephemeral });
          return;
        }
        await i.reply({ embeds: deals.map(dealEmbed) });
      } else if (i.commandName === 'skinstatus') {
        if (!this.skins) {
          await i.reply({ content: 'Skin scanner is not enabled (SKINS_ENABLED=true).', flags: MessageFlags.Ephemeral });
          return;
        }
        const k = this.skins;
        const last = k.lastScanAt ? `<t:${Math.floor(k.lastScanAt / 1000)}:R>` : 'never';
        await i.reply({
          content:
            `**Skin scanner** · last scan ${last} · ${k.scanned} items · deals ${k.lastDeals.length}` +
            (k.lastError ? ` · ⚠️ ${k.lastError}` : '') +
            `
` +
            k.book
              .status()
              .map((m) => `${m.id}: ${m.error ? '⚠️ ' + m.error : m.ageMin === null ? 'loading' : `${m.items} items, ${m.ageMin}m old`}`)
              .join(' · ') +
            `
Min net edge ${(config.skins.minNetEdge * 100).toFixed(1)}% · Skinport break-even spread ${(breakEvenSpread('skinport') * 100).toFixed(1)}% · read-only`,
          flags: MessageFlags.Ephemeral,
        });
      } else if (i.commandName === 'test') {
        if (!this.channel) {
          await i.reply({ content: 'Signals channel not ready.', flags: MessageFlags.Ephemeral });
          return;
        }
        await this.channel.send({ embeds: [testSignalEmbed()] });
        await i.reply({ content: `✅ Test signal posted to <#${config.discord.channelId}>.`, flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      log.warn(`[discord] /${i.commandName} failed`, e);
      const msg = `❌ /${i.commandName} failed: ${e instanceof Error ? e.message : e}`.slice(0, 1900);
      if (i.deferred || i.replied) await i.editReply({ content: msg }).catch(() => {});
      else await i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}
