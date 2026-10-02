import { truncateTail } from '@earendil-works/pi-coding-agent';
import { decodeKittyPrintable, wrapTextWithAnsi, } from '@earendil-works/pi-tui';
import { agentCard, agentTone, availabilityLabel, hasMotionFrame, hasRunningTurn, motionGlyph, } from "./command-center-card.js";
import { orderCommandCenterDirectory } from "./command-center-projection.js";
import { LUMINARIES_IDENTITY } from "./product-identity.js";
import { renderLuminariesProtocolMessage } from "./luminaries-tools.js";
import { isAsciiControlCharacter, sanitizeDisplayText, splitWhitespace } from "./display-sanitizer.js";
import { boundTerminalLines, HOST_TERMINAL_WIDTH } from "./terminal-width.js";
const DEFAULT_TERMINAL_ROWS = 34;
const STATUS_TTL_MS = 4_000;
const PRODUCT = LUMINARIES_IDENTITY.label;
function visibleWidth(value, terminalWidth) {
    return terminalWidth.visibleWidth(value);
}
function truncate(value, width, terminalWidth, ellipsis = '…') {
    return terminalWidth.truncateToWidth(value, Math.max(0, width), ellipsis);
}
export function friendlyError(value) {
    const message = value instanceof Error ? value.message : String(value);
    return sanitizeDisplayText(message, []);
}
function separator(width, theme, terminalWidth) {
    return theme.fg('borderMuted', truncate('─'.repeat(Math.max(1, width)), width, terminalWidth, ''));
}
function collaboratorCount(projection) {
    return projection.agents.filter((agent) => agent.agentId !== projection.rootId).length;
}
function directoryAgents(projection, directoryView) {
    return orderCommandCenterDirectory(projection.directory.filter((agent) => directoryView === 'archived' ? agent.archived : agent.agentId === projection.rootId || !agent.archived), projection.rootId);
}
function workspaceSummary(projection, directoryView) {
    if (directoryView === 'archived')
        return projection.archivedCount ? `${projection.archivedCount} archived` : 'No archived collaborators';
    const luminaries = collaboratorCount(projection);
    if (!luminaries) {
        const retained = projection.closedAgents.filter((agent) => !agent.archived).length;
        return retained
            ? `${retained} retained luminar${retained === 1 ? 'y' : 'ies'} · none open`
            : 'Your constellation starts with one expert';
    }
    const parts = [
        `${luminaries} luminar${luminaries === 1 ? 'y' : 'ies'}`,
        projection.counts.attention ? `✕${projection.counts.attention}` : undefined,
        projection.counts.working ? `${projection.counts.working} working` : undefined,
        projection.counts.waiting ? `${projection.counts.waiting} waiting` : undefined,
        projection.counts.idle ? `${projection.counts.idle} idle` : undefined,
    ].filter((value) => !!value);
    parts.push(`${projection.capacity.available} slots`);
    return parts.join(' · ');
}
function emptyConstellationMessage(projection) {
    const retained = projection.closedAgents.filter((agent) => !agent.archived).length;
    return retained
        ? `${retained} retained luminar${retained === 1 ? 'y' : 'ies'} · v history · n new luminary`
        : 'No luminaries yet. Press n to create, or use Root actions to bring in a Pi session.';
}
function commandHints(projection, selected, directoryView, rootEnter, readOnly) {
    const root = selected?.agentId === projection.rootId;
    const openCollaborators = collaboratorCount(projection);
    const currentRows = directoryAgents(projection, 'current').filter((agent) => agent.agentId !== projection.rootId);
    if (directoryView === 'archived')
        return [
            'Esc return',
            'v current',
            selected ? 'Enter history' : undefined,
            !readOnly && selected ? 'a actions' : undefined,
            selected ? 'i details' : undefined,
        ].filter((value) => !!value);
    if (!currentRows.length)
        return [
            rootEnter === 'return' ? 'Esc return to Pi' : 'Esc return',
            'v archived',
            !readOnly && projection.capacity.available > 0 ? 'n bring in luminary' : undefined,
            !readOnly && root ? 'a actions' : undefined,
        ].filter((value) => !!value);
    return [
        'Esc return',
        'v archived',
        !selected
            ? undefined
            : root
                ? rootEnter === 'return'
                    ? 'Enter Pi'
                    : rootEnter === 'conversation'
                        ? 'Enter open'
                        : 'Enter root actions'
                : 'Enter open',
        !readOnly && selected ? 'a actions' : undefined,
        selected ? 'i details' : undefined,
        '/ find',
        !readOnly && projection.capacity.available > 0 ? 'n new' : undefined,
        !readOnly && openCollaborators >= 2 ? 'b message several' : undefined,
    ].filter((value) => !!value);
}
function searchHint(query, matchCount, selected, rootId, rootEnter) {
    const action = selected
        ? selected.agentId === rootId
            ? rootEnter === 'return'
                ? ' · Enter return to Pi'
                : rootEnter === 'conversation'
                    ? ' · Enter open root conversation'
                    : ' · Enter root actions'
            : ' · Enter open conversation'
        : '';
    return `Find: ${query || '…'} · ${matchCount} match${matchCount === 1 ? '' : 'es'}${action} · Esc cancel`;
}
function agentStatus(agent, phase, includeActivity, directoryView) {
    if (agent.attention)
        return `✕ Needs you${includeActivity && agent.health.observations[0]?.message
            ? ` · ${singleLine(agent.health.observations[0].message)}`
            : ''}`;
    const frame = motionGlyph(agent, phase);
    const posture = `${frame ? `${frame} ` : ''}${availabilityLabel(agent)}`;
    const activity = directoryView === 'archived' && agent.archived
        ? 'archived'
        : includeActivity && agent.humanState === 'waiting' && agent.dependency?.startsWith('Waiting on ')
            ? `for ${agent.dependency.slice('Waiting on '.length)}`
            : includeActivity
                ? singleLine(agent.activity)
                : '';
    return activity ? `${posture} · ${activity}` : posture;
}
function singleLine(value) {
    return splitWhitespace(value).join(' ');
}
export function renderAmbientWidget(projection, width, phase, theme, terminalWidth = HOST_TERMINAL_WIDTH) {
    if (!projection.visible || width < 18)
        return [];
    const summary = [
        projection.counts.attention ? `${projection.counts.attention} need attention` : undefined,
        projection.counts.working ? `${projection.counts.working} working` : undefined,
        projection.counts.waiting ? `${projection.counts.waiting} waiting` : undefined,
    ].filter((value) => !!value);
    if (!summary.length)
        summary.push('Active work');
    const hint = width >= 56 ? ' · Alt+L manage' : ` · /${LUMINARIES_IDENTITY.command}`;
    const header = truncate(`${PRODUCT} · ${summary.join(' · ')}${hint}`, width, terminalWidth);
    const lines = [theme.fg('accent', theme.bold(header))];
    for (const row of projection.ambient) {
        const identity = `${row.prefix}${row.name}`;
        const status = agentStatus(row.agent, phase, false);
        lines.push(theme.fg(agentTone(row.agent), rightAligned(identity, status, width, terminalWidth)));
    }
    return boundTerminalLines(lines, width, terminalWidth);
}
function rightAligned(left, right, width, terminalWidth) {
    const safeWidth = Math.max(1, width);
    const gapWidth = visibleWidth(' ', terminalWidth);
    const reservedLeft = Math.min(visibleWidth(left, terminalWidth), Math.max(10, Math.floor(safeWidth * 0.4)));
    const boundedRight = truncate(right, Math.max(0, safeWidth - gapWidth - reservedLeft), terminalWidth);
    const rightWidth = visibleWidth(boundedRight, terminalWidth);
    const leftWidth = Math.max(0, safeWidth - rightWidth - gapWidth);
    const clippedLeft = truncate(left, leftWidth, terminalWidth);
    const padding = Math.max(0, safeWidth - visibleWidth(clippedLeft, terminalWidth) - rightWidth);
    return truncate(`${clippedLeft}${' '.repeat(padding)}${boundedRight}`, safeWidth, terminalWidth, '');
}
function directoryLine(agent, selected, width, phase, theme, terminalWidth, directoryView, pickerMarks) {
    const marker = selected ? '›' : ' ';
    const recipient = pickerMarks
        ? agent.parentId !== null && agent.lifecycle === 'open'
            ? pickerMarks.has(agent.agentId)
                ? '[✓] '
                : '[ ] '
            : '    '
        : '';
    const prefix = `${marker} ${agent.treePrefix}${recipient}`;
    const status = agentStatus(agent, phase, false, directoryView);
    const statusWidth = visibleWidth(status, terminalWidth);
    const leftWidth = Math.max(1, width - statusWidth - 1);
    const suffix = agent.parentId === null ? '' : ` · ${agent.shortId}`;
    const prefixWidth = Math.max(1, leftWidth - visibleWidth(suffix, terminalWidth));
    const left = `${truncate(`${prefix}${agent.name}`, prefixWidth, terminalWidth)}${suffix}`;
    const padding = ' '.repeat(Math.max(1, width - visibleWidth(left, terminalWidth) - statusWidth));
    const plain = truncate(`${left}${padding}${status}`, width, terminalWidth, '');
    const colored = theme.fg(agent.attention ? 'error' : selected ? 'accent' : agentTone(agent), selected ? theme.bold(plain) : plain);
    return colored;
}
function directoryWindow(agents, selectedId, height) {
    const selected = Math.max(0, agents.findIndex((agent) => agent.agentId === selectedId));
    const safeHeight = Math.max(1, height);
    const start = Math.max(0, Math.min(selected - safeHeight + 1, agents.length - safeHeight));
    return agents.slice(start, start + safeHeight);
}
function factSheetLines(agent, width, height, theme, terminalWidth, complete = false, offset = 0) {
    const card = agentCard(agent, complete);
    const lines = [
        theme.fg(card.tone, theme.bold(rightAligned(card.name, card.state, width, terminalWidth))),
        theme.fg('dim', truncate(card.breadcrumb, width, terminalWidth)),
    ];
    const valueWidth = Math.max(1, width - 2);
    const wrapped = card.fields.map((field) => field.value.split('\n').flatMap((value) => {
        const wrapped = wrapTextWithAnsi(value, valueWidth);
        if (!complete && field.label === 'Recent activity' && wrapped.length > 2)
            return [wrapped[0], truncate(`${wrapped[1]}…`, valueWidth, terminalWidth)];
        return wrapped;
    }));
    if (complete) {
        for (let fieldIndex = 0; fieldIndex < card.fields.length; fieldIndex++) {
            const field = card.fields[fieldIndex];
            if (!field)
                continue;
            const values = wrapped[fieldIndex] ?? [''];
            lines.push(theme.fg('muted', field.label));
            for (const value of values)
                lines.push(`${theme.fg('muted', '  ')}${theme.fg('text', value)}`);
        }
        return lines.slice(offset, offset + height);
    }
    const visibleFieldCount = Math.min(card.fields.length, Math.floor(Math.max(0, height - lines.length) / 2));
    const visibleFields = card.fields.slice(0, visibleFieldCount);
    const allocations = visibleFields.map(() => 1);
    let remaining = Math.max(0, height - lines.length - visibleFields.length * 2);
    while (remaining > 0 && visibleFields.some((_, index) => (allocations[index] ?? 0) < (wrapped[index]?.length ?? 0))) {
        for (let index = 0; index < visibleFields.length && remaining > 0; index++) {
            const allocation = allocations[index] ?? 0;
            if (allocation >= (wrapped[index]?.length ?? 0))
                continue;
            allocations[index] = allocation + 1;
            remaining--;
        }
    }
    for (let fieldIndex = 0; fieldIndex < visibleFields.length; fieldIndex++) {
        const field = visibleFields[fieldIndex];
        if (!field)
            continue;
        const values = wrapped[fieldIndex] ?? [''];
        const allocation = allocations[fieldIndex] ?? 1;
        lines.push(theme.fg('muted', field.label));
        for (let lineIndex = 0; lineIndex < allocation; lineIndex++) {
            let value = values[lineIndex] ?? '';
            if (lineIndex === allocation - 1 && allocation < values.length)
                value = truncate(`${value}…`, valueWidth, terminalWidth);
            lines.push(`${theme.fg('muted', '  ')}${theme.fg('text', value)}`);
        }
    }
    return lines.slice(0, height);
}
function factSheetLineCount(agent, width, theme, terminalWidth) {
    return factSheetLines(agent, width, Number.MAX_SAFE_INTEGER, theme, terminalWidth, true).length;
}
function conversationHeaderLines(agent, width, theme, terminalWidth) {
    const identity = agent.role ? `${agent.handle} · ${agent.role}` : agent.handle;
    const facts = [agent.model, agent.thinking, agent.contextMode].filter(Boolean).join(' · ');
    const label = identity;
    const state = availabilityLabel(agent);
    const current = state === 'Compacting' && agent.activity === 'Compacting context'
        ? state
        : agent.activity
            ? `${state} · ${singleLine(agent.activity)}`
            : state;
    const wake = state === 'Parked' ? ' · message to wake' : '';
    const status = `${current}${wake}${agent.attention ? ' · Needs you' : ''} · Esc directory`;
    return [
        theme.fg(agentTone(agent), theme.bold(rightAligned(label, status, width, terminalWidth))),
        theme.fg('dim', truncate(`${agent.breadcrumb.join(' › ')}${facts ? ` · ${facts}` : ''}`, width, terminalWidth)),
    ];
}
function messageText(message) {
    if (typeof message.content === 'string')
        return message.content;
    if (!Array.isArray(message.content))
        return undefined;
    const parts = message.content
        .filter((part) => typeof part === 'object' && part !== null && !Array.isArray(part) && part.type === 'text')
        .map((part) => part.text)
        .filter((value) => typeof value === 'string');
    return parts.length ? parts.join('') : undefined;
}
function messageParts(message) {
    return Array.isArray(message.content)
        ? message.content.filter((part) => typeof part === 'object' && part !== null && !Array.isArray(part))
        : [];
}
function isNativeAssistantMessage(message) {
    return message.role === 'assistant';
}
function isNativeCustomMessage(message) {
    return message.role === 'custom';
}
function isNativeBranchSummaryMessage(message) {
    return message.role === 'branchSummary';
}
function isNativeCompactionSummaryMessage(message) {
    return message.role === 'compactionSummary';
}
function toolResult(message) {
    if (message.role !== 'toolResult' || !Array.isArray(message.content))
        return undefined;
    const content = [];
    for (const part of message.content) {
        if (typeof part !== 'object' || part === null || Array.isArray(part))
            continue;
        if (part.type === 'text' && typeof part.text === 'string')
            content.push({ type: 'text', text: part.text });
        else if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string')
            content.push({ type: 'image', data: part.data, mimeType: part.mimeType });
    }
    return {
        content,
        ...(message.details !== undefined ? { details: message.details } : {}),
        isError: message.isError === true,
    };
}
function unfinishedToolResult(message) {
    if (message.stopReason !== 'aborted' && message.stopReason !== 'error')
        return undefined;
    const text = typeof message.errorMessage === 'string'
        ? message.errorMessage
        : message.stopReason === 'aborted'
            ? 'Operation aborted'
            : 'Error';
    return { content: [{ type: 'text', text }], isError: true };
}
function historicalTruncation(output) {
    const truncation = truncateTail(output);
    truncation.truncated = true;
    return truncation;
}
export class LuminariesCommandCenterComponent {
    focused = true;
    view = 'directory';
    directoryView = 'current';
    selectedId;
    selectedByView = {};
    searchQuery;
    searchRestoreId;
    factSheetOpen = false;
    factSheetOffset = 0;
    pickerMarks;
    status;
    statusTimer;
    busy = false;
    conversationTailOffset = 0;
    visibleMotion = false;
    disposed = false;
    toolsExpanded = false;
    thinkingHidden = false;
    conversation = [];
    conversationEpoch;
    conversationIncarnation;
    conversationRevision = 0;
    conversationHydrated = false;
    conversationUnsubscribe;
    nativeAgentId;
    /** One component group per conversation message; unchanged messages reuse their Pi-native components. */
    nativeGroups = [];
    nativeGroupWidth = 0;
    nativeLineTotal;
    directoryRenderWidth;
    editor;
    editorAgentId;
    getProjection;
    getPhase;
    theme;
    actions;
    requestRender;
    done;
    getTerminalRows;
    terminalWidth;
    nativeUi;
    rootEnter;
    constructor(getProjection, getPhase, theme, actions, requestRender, done, getTerminalRows = () => DEFAULT_TERMINAL_ROWS, terminalWidth = HOST_TERMINAL_WIDTH, nativeUi, options = {}) {
        this.getProjection = getProjection;
        this.getPhase = getPhase;
        this.theme = theme;
        this.actions = actions;
        this.requestRender = requestRender;
        this.done = done;
        this.getTerminalRows = getTerminalRows;
        this.terminalWidth = terminalWidth;
        this.nativeUi = nativeUi;
        this.rootEnter = options.rootEnter ?? 'return';
        const projection = getProjection();
        const initialAgent = options.initialAgentId
            ? projection.directory.find((agent) => agent.agentId === options.initialAgentId)
            : undefined;
        if (initialAgent?.archived)
            this.directoryView = 'archived';
        const initialAgents = directoryAgents(projection, this.directoryView);
        const fallbackId = initialAgents.find((agent) => agent.attention)?.agentId ??
            initialAgents.find((agent) => agent.agentId !== projection.rootId && agent.active)?.agentId ??
            projection.agents.find((agent) => agent.agentId !== projection.rootId)?.agentId ??
            projection.rootId;
        this.selectedId = initialAgent ? initialAgent.agentId : fallbackId;
        this.selectedByView[this.directoryView] = this.selectedId;
        if (options.initialAgentId && this.selectedId !== projection.rootId)
            this.view = 'agent';
        if (nativeUi) {
            this.editor = new nativeUi.CustomEditor(nativeUi.tui, {
                borderColor: (text) => theme.fg('accent', text),
                selectList: nativeUi.selectListTheme,
            }, nativeUi.keybindings, { paddingX: 0 });
            this.editor.onSubmit = (text) => this.submitEditor(text, 'auto');
            this.editor.onEscape = () => this.returnToDirectory();
            this.editor.onAction('app.message.followUp', () => this.submitEditor(this.editor?.getText() ?? '', 'follow_up'));
            this.editor.onAction('app.clear', () => this.clearOrInterrupt());
            this.editor.onAction('app.tools.expand', () => {
                this.toolsExpanded = !this.toolsExpanded;
                this.rebuildNativeComponents(this.selectedAgent(this.getProjection()));
                this.safeRender();
            });
            this.editor.onAction('app.thinking.toggle', () => {
                this.thinkingHidden = !this.thinkingHidden;
                this.rebuildNativeComponents(this.selectedAgent(this.getProjection()));
                this.safeRender();
            });
        }
        if (this.view === 'agent')
            this.openConversation(this.selectedAgent(projection));
        this.clampScrollOffsets(projection);
    }
    render(width) {
        const projection = this.getProjection();
        const selected = this.selectedAgent(projection);
        const safeWidth = Math.max(1, width);
        if (safeWidth < 28)
            return boundTerminalLines([truncate(`${PRODUCT} needs 28 columns.`, safeWidth, this.terminalWidth)], safeWidth, this.terminalWidth);
        const rows = Math.max(1, this.getTerminalRows());
        if (this.view === 'directory') {
            if (this.factSheetOpen && this.directoryRenderWidth !== undefined && this.directoryRenderWidth !== safeWidth)
                this.factSheetOffset = 0;
            this.directoryRenderWidth = safeWidth;
        }
        if (this.view === 'agent') {
            this.setVisibleMotion(hasMotionFrame(selected));
            return this.renderAgent(selected, safeWidth, rows);
        }
        const lines = rows < 10
            ? this.renderCompact(projection, safeWidth, rows)
            : this.renderDirectory(projection, selected, safeWidth, rows);
        return boundTerminalLines(lines, safeWidth, this.terminalWidth);
    }
    handleInput(data) {
        data = decodeKittyPrintable(data) ?? data;
        if (this.status && !this.busy) {
            if (!this.status.persistent)
                this.setStatus(undefined);
            else if (this.matches(data, 'tui.select.cancel')) {
                this.setStatus(undefined);
                this.safeRender();
                return;
            }
        }
        const projection = this.getProjection();
        this.reconcileProjection(projection);
        this.clampScrollOffsets(projection);
        const selected = this.selectedAgent(projection);
        if (this.view === 'agent') {
            if (this.matches(data, 'tui.altScreen.pageUp')) {
                this.scrollConversation(8);
                return;
            }
            if (this.matches(data, 'tui.altScreen.pageDown')) {
                this.scrollConversation(-8);
                return;
            }
            if (selected.lifecycle === 'closed' || this.actions.readOnlyReason?.()) {
                if (this.matches(data, 'tui.select.cancel'))
                    this.returnToDirectory();
                return;
            }
            if (!this.editor) {
                if (this.matches(data, 'tui.select.cancel'))
                    this.returnToDirectory();
                return;
            }
            this.editor.focused = this.focused;
            this.editor.handleInput(data);
            this.clampScrollOffsets(this.getProjection());
            return;
        }
        if (this.factSheetOpen) {
            if (data === 'i' || this.matches(data, 'tui.select.cancel')) {
                this.factSheetOpen = false;
                this.factSheetOffset = 0;
            }
            else if (this.matches(data, 'tui.select.up'))
                this.scrollFactSheet(-1, selected);
            else if (this.matches(data, 'tui.select.down'))
                this.scrollFactSheet(1, selected);
            else if (this.matches(data, 'tui.select.pageUp'))
                this.scrollFactSheet(-8, selected);
            else if (this.matches(data, 'tui.select.pageDown'))
                this.scrollFactSheet(8, selected);
            this.safeRender();
            return;
        }
        if (this.pickerMarks) {
            this.handlePicker(data, projection, selected);
            this.safeRender();
            return;
        }
        if (this.searchQuery !== undefined) {
            this.handleSearch(data, projection);
            return;
        }
        if (this.matches(data, 'tui.select.cancel')) {
            this.disposed = true;
            this.done();
            this.safeRender();
            return;
        }
        this.handleDirectory(data, projection);
        this.safeRender();
    }
    scrollBy(lines) {
        const projection = this.getProjection();
        this.reconcileProjection(projection);
        if (this.view === 'agent') {
            this.rebuildNativeComponents(this.selectedAgent(projection));
            this.clampScrollOffsets(projection);
            this.scrollConversation(-lines);
        }
        else {
            this.clampScrollOffsets(projection);
            if (this.factSheetOpen)
                this.scrollFactSheet(lines, this.selectedAgent(projection));
            else
                this.move(lines, projection);
            this.safeRender();
        }
    }
    invalidate() {
        const projection = this.getProjection();
        this.reconcileProjection(projection);
        if (this.view === 'agent') {
            const selected = this.selectedAgent(projection);
            this.setVisibleMotion(hasMotionFrame(selected));
            this.rebuildNativeComponents(selected);
        }
        this.clampScrollOffsets(projection);
        this.safeRender();
    }
    dispose() {
        this.disposed = true;
        this.focused = false;
        this.conversationUnsubscribe?.();
        this.conversationUnsubscribe = undefined;
        if (this.statusTimer)
            clearTimeout(this.statusTimer);
    }
    hasVisibleMotion() {
        return this.visibleMotion;
    }
    renderCompact(projection, width, terminalRows) {
        const visibleAgents = this.filteredDirectoryAgents(projection);
        const visibleSelected = this.visibleSelectedAgent(projection);
        const readOnlyReason = this.actions.readOnlyReason?.();
        const footer = this.directoryFooterLines(projection, visibleSelected, visibleAgents.length, readOnlyReason !== undefined, width);
        const bodyHeight = Math.max(0, terminalRows - 1 - footer.length);
        let body;
        if (this.factSheetOpen && visibleSelected) {
            this.clampFactSheetOffset(visibleSelected, width, bodyHeight);
            body = factSheetLines(visibleSelected, width, bodyHeight, this.theme, this.terminalWidth, true, this.factSheetOffset);
        }
        else if (visibleSelected)
            body = [
                directoryLine(visibleSelected, true, width, this.getPhase(), this.theme, this.terminalWidth, this.directoryView, this.pickerMarks),
            ];
        else
            body = [
                this.theme.fg('muted', truncate(this.searchQuery === undefined
                    ? this.directoryView === 'archived'
                        ? 'No archived collaborators.'
                        : emptyConstellationMessage(projection)
                    : 'No matching collaborators.', width, this.terminalWidth)),
            ];
        this.setVisibleMotion(!this.factSheetOpen && !!visibleSelected && hasMotionFrame(visibleSelected));
        const lines = [
            this.directoryTitle(projection, width, readOnlyReason),
            ...body,
            ...footer.map((line) => this.theme.fg(this.status?.tone ?? (this.searchQuery !== undefined ? 'accent' : 'dim'), line)),
        ];
        return lines.slice(0, terminalRows);
    }
    renderDirectory(projection, selected, width, terminalRows) {
        const visibleAgents = this.filteredDirectoryAgents(projection);
        const visibleSelected = this.visibleSelectedAgent(projection);
        const readOnlyReason = this.actions.readOnlyReason?.();
        const footer = this.directoryFooterLines(projection, visibleSelected, visibleAgents.length, readOnlyReason !== undefined, width);
        const bodyHeight = Math.max(1, terminalRows - 3 - footer.length);
        const lines = [
            this.directoryTitle(projection, width, readOnlyReason),
            separator(width, this.theme, this.terminalWidth),
        ];
        let window = [];
        if (this.factSheetOpen && visibleSelected) {
            this.clampFactSheetOffset(visibleSelected, width, bodyHeight);
            lines.push(...factSheetLines(visibleSelected, width, bodyHeight, this.theme, this.terminalWidth, true, this.factSheetOffset));
        }
        else if (!visibleAgents.length) {
            lines.push(this.theme.fg('muted', truncate(this.searchQuery === undefined
                ? this.directoryView === 'archived'
                    ? 'No archived collaborators.'
                    : emptyConstellationMessage(projection)
                : 'No matching collaborators.', width, this.terminalWidth)));
        }
        else {
            const wideInspector = width >= 86 &&
                visibleSelected &&
                !this.pickerMarks &&
                (collaboratorCount(projection) > 0 || visibleSelected.attention);
            const directoryWidth = wideInspector ? Math.max(32, Math.min(48, Math.floor(width * 0.42))) : width;
            window = directoryWindow(visibleAgents, selected.agentId, bodyHeight);
            const directoryLines = window.map((agent) => directoryLine(agent, agent.agentId === selected.agentId, directoryWidth, this.getPhase(), this.theme, this.terminalWidth, this.directoryView, this.pickerMarks));
            if (wideInspector) {
                const divider = this.theme.fg('borderMuted', ' | ');
                const inspectorWidth = Math.max(1, width - directoryWidth - 3);
                const inspector = factSheetLines(visibleSelected, inspectorWidth, bodyHeight, this.theme, this.terminalWidth);
                for (let index = 0; index < Math.max(directoryLines.length, inspector.length); index++) {
                    const left = truncate(directoryLines[index] ?? '', directoryWidth, this.terminalWidth, '');
                    const padding = ' '.repeat(Math.max(0, directoryWidth - visibleWidth(left, this.terminalWidth)));
                    lines.push(`${left}${padding}${divider}${inspector[index] ?? ''}`);
                }
            }
            else
                lines.push(...directoryLines);
            if (visibleAgents.length === 1 && visibleAgents[0]?.agentId === projection.rootId) {
                lines.push('');
                lines.push(this.theme.fg('muted', truncate(emptyConstellationMessage(projection), width, this.terminalWidth)));
            }
        }
        this.setVisibleMotion(!this.factSheetOpen && window.some(hasMotionFrame));
        while (lines.length < terminalRows - 1 - footer.length)
            lines.push('');
        lines.push(separator(width, this.theme, this.terminalWidth));
        lines.push(...footer.map((line) => this.theme.fg(this.status?.tone ?? (this.searchQuery !== undefined || this.pickerMarks ? 'accent' : 'dim'), line)));
        return lines;
    }
    directoryTitle(projection, width, readOnlyReason) {
        const current = this.directoryView === 'current'
            ? this.theme.fg('accent', this.theme.bold('[Current]'))
            : this.theme.fg('dim', 'Current');
        const archived = this.directoryView === 'archived'
            ? this.theme.fg('accent', this.theme.bold('[Archived]'))
            : this.theme.fg('dim', 'Archived');
        const views = `${current} ${archived}`;
        const summary = readOnlyReason ?? workspaceSummary(projection, this.directoryView);
        const title = width < 100 ? 'Constellation' : `${LUMINARIES_IDENTITY.label} · Constellation`;
        const product = this.theme.fg('accent', this.theme.bold(title));
        const left = width < 40 ? views : `${product}   ${views}`;
        return visibleWidth(`${left} ${summary}`, this.terminalWidth) <= width
            ? rightAligned(left, summary, width, this.terminalWidth)
            : truncate(left, width, this.terminalWidth);
    }
    directoryFooterLines(projection, selected, matchCount, readOnly, width) {
        const value = this.factSheetOpen
            ? 'Esc close details · ↑↓ scroll · PgUp/PgDn'
            : this.status
                ? this.status.text
                : this.pickerMarks
                    ? `Recipients · ${this.pickerMarks.size} marked · Space/t mark · a all-or-none · Enter compose · Esc cancel`
                    : this.searchQuery !== undefined
                        ? searchHint(this.searchQuery, matchCount, selected, projection.rootId, this.rootEnter)
                        : commandHints(projection, selected, this.directoryView, this.rootEnter, readOnly).join(' · ');
        return this.status?.persistent
            ? [...wrapTextWithAnsi(value, Math.max(1, width)), 'Esc dismiss']
            : [truncate(value, Math.max(1, width), this.terminalWidth)];
    }
    setVisibleMotion(visible) {
        if (this.visibleMotion === visible)
            return;
        this.visibleMotion = visible;
        this.actions.motionChanged?.();
    }
    renderAgent(selected, width, terminalRows) {
        const header = conversationHeaderLines(selected, width, this.theme, this.terminalWidth);
        if (terminalRows <= header.length)
            return header.slice(0, terminalRows);
        if (!this.nativeUi)
            return [
                ...header,
                ...Array.from({ length: terminalRows - header.length - 1 }, () => ''),
                this.theme.fg('error', truncate('Pi native conversation components are unavailable.', width, this.terminalWidth)),
            ];
        this.syncNativeGroups(selected);
        this.ensureNativeLines(width);
        const lineCount = this.nativeLineTotal ?? 0;
        const readOnlyReason = this.actions.readOnlyReason?.();
        const statusLines = readOnlyReason
            ? [this.theme.fg('warning', truncate(readOnlyReason, width, this.terminalWidth))]
            : this.status
                ? [this.theme.fg(this.status.tone, truncate(this.status.text, width, this.terminalWidth))]
                : !this.conversationHydrated
                    ? [this.theme.fg('muted', truncate('Loading conversation history…', width, this.terminalWidth))]
                    : [];
        let editorLines = [];
        if (!readOnlyReason && selected.lifecycle !== 'closed' && this.editor) {
            this.editor.focused = this.focused;
            editorLines = this.editor.render(width);
        }
        const maximumEditorHeight = Math.max(0, terminalRows - header.length - statusLines.length);
        if (editorLines.length > maximumEditorHeight)
            editorLines = editorLines.slice(-maximumEditorHeight);
        const conversationHeight = Math.max(0, terminalRows - header.length - statusLines.length - editorLines.length);
        const maximumOffset = Math.max(0, lineCount - conversationHeight);
        const tailOffset = Math.min(this.conversationTailOffset, maximumOffset);
        const end = Math.max(0, lineCount - tailOffset);
        const start = Math.max(0, end - conversationHeight);
        const visibleConversation = this.nativeLines(start, end);
        const padding = Array.from({ length: conversationHeight - visibleConversation.length }, () => '');
        return [...header, ...padding, ...visibleConversation, ...statusLines, ...editorLines];
    }
    /** Per-message Pi-native component reuse: unchanged messages keep their components and cached lines. */
    nativeGroupCache = new WeakMap();
    nativeConversationRef;
    nativeFlags = { toolsExpanded: false, thinkingHidden: false };
    nativeResults = new Map();
    /** Kept as the single external entry point; all invalidation is reference/flag-driven. */
    rebuildNativeComponents(agent) {
        this.syncNativeGroups(agent);
    }
    syncNativeGroups(agent) {
        if (!this.nativeUi)
            return;
        const flagsChanged = this.nativeFlags.toolsExpanded !== this.toolsExpanded || this.nativeFlags.thinkingHidden !== this.thinkingHidden;
        const agentSwitched = this.nativeAgentId !== agent.agentId;
        const conversationChanged = this.nativeConversationRef !== this.conversation;
        if (!agentSwitched && !conversationChanged && !flagsChanged)
            return;
        const priorTotal = !agentSwitched && !flagsChanged && this.conversationTailOffset > 0 ? this.conversationLineTotal() : undefined;
        if (agentSwitched || flagsChanged)
            this.nativeGroupCache = new WeakMap();
        const priorGroups = agentSwitched || flagsChanged ? [] : this.nativeGroups;
        const priorResults = new Map();
        for (const group of priorGroups)
            if (group.message.role === 'toolResult' && typeof group.message.toolCallId === 'string')
                priorResults.set(group.message.toolCallId, group.message);
        const results = new Map();
        for (const message of this.conversation)
            if (message.role === 'toolResult' && typeof message.toolCallId === 'string')
                results.set(message.toolCallId, message);
        const changedResultIds = new Set();
        for (const [id, message] of priorResults)
            if (results.get(id) !== message)
                changedResultIds.add(id);
        for (const [id, message] of results)
            if (priorResults.get(id) !== message)
                changedResultIds.add(id);
        this.nativeResults = results;
        const groups = [];
        let hasPriorContent = false;
        for (const message of this.conversation) {
            let group = this.nativeGroupCache.get(message);
            if (group?.hasPriorContent !== hasPriorContent || group?.toolCallIds.some((id) => changedResultIds.has(id)))
                group = undefined;
            if (!group) {
                group = this.buildNativeGroup(message, hasPriorContent, agent);
                this.nativeGroupCache.set(message, group);
            }
            if (group.components.length)
                hasPriorContent = true;
            groups.push(group);
        }
        this.nativeFlags = { toolsExpanded: this.toolsExpanded, thinkingHidden: this.thinkingHidden };
        this.nativeAgentId = agent.agentId;
        this.nativeConversationRef = this.conversation;
        this.nativeGroups = groups;
        this.nativeLineTotal = undefined;
        if (priorTotal !== undefined)
            this.conversationTailOffset = Math.max(0, this.conversationTailOffset + this.conversationLineTotal() - priorTotal);
    }
    buildNativeGroup(message, hasPriorContent, agent) {
        const ui = this.nativeUi;
        if (!ui)
            return { message, components: [], toolCallIds: [], hasPriorContent, lines: [] };
        const components = [];
        const toolCallIds = [];
        if (message.role === 'user') {
            const text = messageText(message);
            if (text) {
                if (hasPriorContent)
                    components.push(new ui.Spacer(1));
                if (typeof message.attribution === 'string')
                    components.push(new ui.Text(this.theme.fg('dim', message.attribution)));
                const skillBlock = ui.parseSkillBlock(text);
                if (skillBlock) {
                    const skill = new ui.SkillInvocationMessageComponent(skillBlock, ui.markdownTheme);
                    skill.setExpanded(this.toolsExpanded);
                    components.push(skill);
                    if (skillBlock.userMessage) {
                        components.push(new ui.Spacer(1));
                        components.push(new ui.UserMessageComponent(skillBlock.userMessage, ui.markdownTheme));
                    }
                }
                else
                    components.push(new ui.UserMessageComponent(text, ui.markdownTheme));
            }
            return { message, components, toolCallIds, hasPriorContent };
        }
        if (isNativeAssistantMessage(message)) {
            const assistant = new ui.AssistantMessageComponent(message, this.thinkingHidden, ui.markdownTheme);
            assistant.setHideThinkingBlock(this.thinkingHidden);
            components.push(assistant);
            for (const part of messageParts(message)) {
                if (part.type !== 'toolCall' || typeof part.id !== 'string' || typeof part.name !== 'string')
                    continue;
                const tool = new ui.ToolExecutionComponent(part.name, part.id, part.arguments ?? {}, undefined, ui.toolDefinitions?.get(part.name), ui.tui, agent.cwd);
                const resultMessage = this.nativeResults.get(part.id);
                const result = resultMessage ? toolResult(resultMessage) : unfinishedToolResult(message);
                if (result)
                    tool.updateResult(result, resultMessage?.isPartial === true);
                tool.setExpanded(this.toolsExpanded);
                components.push(tool);
                toolCallIds.push(part.id);
            }
            return { message, components, toolCallIds, hasPriorContent };
        }
        if (isNativeCustomMessage(message) && message.display) {
            const custom = new ui.CustomMessageComponent(message, message.customType === LUMINARIES_IDENTITY.namespace.protocolMessageType
                ? renderLuminariesProtocolMessage
                : undefined, ui.markdownTheme);
            custom.setExpanded(this.toolsExpanded);
            components.push(custom);
            return { message, components, toolCallIds, hasPriorContent };
        }
        if (isNativeBranchSummaryMessage(message)) {
            components.push(new ui.Spacer(1));
            const summary = new ui.BranchSummaryMessageComponent(message, ui.markdownTheme);
            summary.setExpanded(this.toolsExpanded);
            components.push(summary);
            return { message, components, toolCallIds, hasPriorContent };
        }
        if (isNativeCompactionSummaryMessage(message)) {
            components.push(new ui.Spacer(1));
            const summary = new ui.CompactionSummaryMessageComponent(message, ui.markdownTheme);
            summary.setExpanded(this.toolsExpanded);
            components.push(summary);
            return { message, components, toolCallIds, hasPriorContent };
        }
        if (message.role === 'bashExecution' && typeof message.command === 'string') {
            const bash = new ui.BashExecutionComponent(message.command, ui.tui, message.excludeFromContext === true);
            if (typeof message.output === 'string' && message.output)
                bash.appendOutput(message.output);
            bash.setComplete(typeof message.exitCode === 'number' ? message.exitCode : undefined, message.cancelled === true, message.truncated === true
                ? historicalTruncation(typeof message.output === 'string' ? message.output : '')
                : undefined, typeof message.fullOutputPath === 'string' ? message.fullOutputPath : undefined);
            bash.setExpanded(this.toolsExpanded);
            components.push(bash);
        }
        return { message, components, toolCallIds, hasPriorContent };
    }
    ensureNativeLines(width) {
        if (width === this.nativeGroupWidth && this.nativeLineTotal !== undefined)
            return;
        this.nativeGroupWidth = width;
        let total = 0;
        for (const group of this.nativeGroups) {
            if (group.width !== width) {
                group.lines = group.components.flatMap((component) => component.render(width));
                group.width = width;
            }
            total += group.lines?.length ?? 0;
        }
        this.nativeLineTotal = total;
    }
    nativeLines(start, end) {
        const lines = [];
        let offset = 0;
        for (const group of this.nativeGroups) {
            const groupLines = group.lines ?? [];
            const groupEnd = offset + groupLines.length;
            if (groupEnd > start && offset < end)
                lines.push(...groupLines.slice(Math.max(0, start - offset), Math.min(groupLines.length, end - offset)));
            offset = groupEnd;
            if (offset >= end)
                break;
        }
        return lines;
    }
    conversationLineTotal() {
        const width = Math.max(1, Math.floor(this.nativeUi?.tui.terminal?.columns ?? this.nativeGroupWidth));
        if (!width)
            return 0;
        this.ensureNativeLines(width);
        return this.nativeLineTotal ?? 0;
    }
    handleDirectory(data, projection) {
        const visibleSelected = this.visibleSelectedAgent(projection);
        if (this.matches(data, 'tui.select.up'))
            this.move(-1, projection);
        else if (this.matches(data, 'tui.select.down'))
            this.move(1, projection);
        else if (this.matches(data, 'tui.select.pageUp'))
            this.move(-8, projection);
        else if (this.matches(data, 'tui.select.pageDown'))
            this.move(8, projection);
        else if (this.actions.readOnlyReason?.() && (data === 'n' || data === 'b' || data === 'a')) {
            this.setStatus({ tone: 'warning', text: this.actions.readOnlyReason?.() ?? 'This view is read-only.' }, false);
        }
        else if (data === 'v')
            this.toggleDirectoryView(projection);
        else if (data === 'i' && visibleSelected) {
            this.setStatus(undefined);
            this.factSheetOpen = true;
            this.factSheetOffset = 0;
        }
        else if (data === '/') {
            this.setStatus(undefined);
            this.searchRestoreId = this.selectedId;
            this.searchQuery = '';
        }
        else if (data === 'n' &&
            this.directoryView === 'current' &&
            projection.capacity.available > 0 &&
            this.actions.spawn)
            this.runAction(() => this.actions.spawn?.());
        else if (data === 'b' &&
            this.directoryView === 'current' &&
            collaboratorCount(projection) >= 2 &&
            this.actions.multicast) {
            this.pickerMarks = new Set();
            this.setStatus(undefined);
        }
        else if (data === 'a' && visibleSelected && this.actions.palette)
            this.runAction(() => this.actions.palette?.(visibleSelected.agentId));
        else if (this.matches(data, 'tui.select.confirm') && visibleSelected)
            this.activateSelected(visibleSelected, projection);
    }
    handlePicker(data, projection, selected) {
        const marks = this.pickerMarks;
        if (!marks)
            return;
        if (this.matches(data, 'tui.select.cancel')) {
            this.pickerMarks = undefined;
            this.setStatus(undefined);
            return;
        }
        if (this.matches(data, 'tui.select.up'))
            this.move(-1, projection);
        else if (this.matches(data, 'tui.select.down'))
            this.move(1, projection);
        else if (this.matches(data, 'tui.select.pageUp'))
            this.move(-8, projection);
        else if (this.matches(data, 'tui.select.pageDown'))
            this.move(8, projection);
        else if (data === 'a') {
            const agents = this.filteredDirectoryAgents(projection);
            const terminalRows = Math.max(1, this.getTerminalRows());
            const visible = terminalRows < 10
                ? [this.visibleSelectedAgent(projection)].filter((agent) => agent !== undefined)
                : directoryWindow(agents, this.selectedId, Math.max(1, terminalRows - 4));
            const recipients = visible.filter((agent) => agent.parentId !== null && agent.lifecycle === 'open');
            const remove = recipients.length > 0 && recipients.every((agent) => marks.has(agent.agentId));
            for (const agent of recipients) {
                if (remove)
                    marks.delete(agent.agentId);
                else
                    marks.add(agent.agentId);
            }
        }
        else if (data === ' ' || data === 't') {
            if (selected.parentId === null || selected.lifecycle !== 'open')
                return;
            if (marks.has(selected.agentId))
                marks.delete(selected.agentId);
            else
                marks.add(selected.agentId);
        }
        else if (this.matches(data, 'tui.select.confirm')) {
            if (!marks.size) {
                this.setStatus({ tone: 'muted', text: 'Recipients · 0 marked · Mark an open collaborator first.' });
                return;
            }
            const recipientIds = [...marks];
            this.pickerMarks = undefined;
            this.runAction(() => this.actions.multicast?.(recipientIds));
        }
    }
    toggleDirectoryView(projection) {
        this.selectedByView[this.directoryView] = this.selectedId;
        this.directoryView = this.directoryView === 'current' ? 'archived' : 'current';
        const agents = directoryAgents(projection, this.directoryView);
        const remembered = this.selectedByView[this.directoryView];
        const selected = agents.find((agent) => agent.agentId === remembered) ??
            agents.find((agent) => agent.attention) ??
            agents.find((agent) => agent.active) ??
            agents[0];
        this.selectedId = selected?.agentId ?? projection.rootId;
        this.selectedByView[this.directoryView] = this.selectedId;
        this.searchQuery = undefined;
        this.searchRestoreId = undefined;
        this.factSheetOpen = false;
        this.factSheetOffset = 0;
        this.pickerMarks = undefined;
        this.setStatus(undefined);
    }
    handleSearch(data, projection) {
        if (this.matches(data, 'tui.select.cancel')) {
            this.searchQuery = undefined;
            if (this.searchRestoreId &&
                directoryAgents(projection, this.directoryView).some((agent) => agent.agentId === this.searchRestoreId))
                this.selectedId = this.searchRestoreId;
            this.searchRestoreId = undefined;
        }
        else if (this.matches(data, 'tui.select.confirm')) {
            const selected = this.visibleSelectedAgent(projection);
            if (!selected) {
                this.safeRender();
                return;
            }
            this.searchQuery = undefined;
            this.searchRestoreId = undefined;
            this.activateSelected(selected, projection);
        }
        else if (this.matches(data, 'tui.select.up')) {
            this.move(-1, projection);
        }
        else if (this.matches(data, 'tui.select.down')) {
            this.move(1, projection);
        }
        else if (this.matches(data, 'tui.editor.deleteCharBackward')) {
            this.searchQuery = [...(this.searchQuery ?? '')].slice(0, -1).join('');
        }
        else if (!isAsciiControlCharacter(data) && Buffer.byteLength((this.searchQuery ?? '') + data) <= 512) {
            this.searchQuery = (this.searchQuery ?? '') + data;
        }
        const first = this.filteredDirectoryAgents(projection)[0];
        if (first && !this.filteredDirectoryAgents(projection).some((agent) => agent.agentId === this.selectedId)) {
            this.selectedId = first.agentId;
            this.selectedByView[this.directoryView] = first.agentId;
        }
        this.safeRender();
    }
    filteredDirectoryAgents(projection) {
        const agents = directoryAgents(projection, this.directoryView);
        const query = this.searchQuery?.trim().toLocaleLowerCase();
        if (!query)
            return agents;
        return agents.filter((agent) => [
            agent.name,
            agent.handle,
            agent.shortId,
            agent.agentId,
            agent.role,
            agent.focus,
            agent.assignment,
            ...agent.expertise,
            ...agent.artifacts,
            availabilityLabel(agent),
            agent.activity,
            agent.attention ? 'needs you' : undefined,
            agent.attention ? agent.health.summary : undefined,
            agent.archived ? 'archived' : undefined,
        ]
            .filter((value) => typeof value === 'string')
            .some((value) => value.toLocaleLowerCase().includes(query)));
    }
    visibleSelectedAgent(projection) {
        const visible = this.filteredDirectoryAgents(projection);
        return visible.find((agent) => agent.agentId === this.selectedId) ?? visible[0];
    }
    selectedAgent(projection) {
        const all = projection.directory;
        const visible = this.view === 'directory' ? this.filteredDirectoryAgents(projection) : all;
        const selected = visible.find((agent) => agent.agentId === this.selectedId) ??
            visible[0] ??
            all.find((agent) => agent.agentId === this.selectedId) ??
            all[0];
        if (!selected)
            throw new Error(`${PRODUCT} command center has no root collaborator`);
        return selected;
    }
    matches(data, action) {
        return this.nativeUi?.keybindings.matches(data, action) === true;
    }
    conversationScrollMaximum(agent) {
        if (!this.nativeUi)
            return 0;
        const width = Math.max(1, this.nativeUi.tui.terminal?.columns ?? 1);
        const terminalRows = Math.max(1, this.getTerminalRows());
        const headerHeight = conversationHeaderLines(agent, width, this.theme, this.terminalWidth).length;
        const statusHeight = this.status ? 1 : 0;
        let editorHeight = agent.lifecycle !== 'closed' && this.editor ? this.editor.render(width).length : 0;
        editorHeight = Math.min(editorHeight, Math.max(0, terminalRows - headerHeight - statusHeight));
        const conversationHeight = Math.max(0, terminalRows - headerHeight - statusHeight - editorHeight);
        const lineCount = this.conversationLineTotal();
        return Math.max(0, lineCount - conversationHeight);
    }
    clampScrollOffsets(projection) {
        if (this.view === 'agent') {
            this.conversationTailOffset = Math.min(this.conversationTailOffset, this.conversationScrollMaximum(this.selectedAgent(projection)));
        }
    }
    reconcileProjection(projection) {
        if (this.view === 'agent' && !projection.directory.some((agent) => agent.agentId === this.selectedId))
            this.returnToDirectory(true);
        const selected = this.selectedAgent(projection);
        if (selected.agentId !== this.selectedId) {
            this.selectedId = selected.agentId;
            this.selectedByView[this.directoryView] = selected.agentId;
            this.conversationTailOffset = 0;
            this.factSheetOpen = false;
            this.factSheetOffset = 0;
        }
    }
    move(delta, projection) {
        const agents = this.filteredDirectoryAgents(projection);
        if (!agents.length)
            return;
        const index = Math.max(0, agents.findIndex((agent) => agent.agentId === this.selectedId));
        const next = Math.max(0, Math.min(agents.length - 1, index + delta));
        this.selectedId = agents[next]?.agentId ?? this.selectedId;
        this.selectedByView[this.directoryView] = this.selectedId;
        this.setStatus(undefined);
    }
    clampFactSheetOffset(agent, width, height) {
        const maximum = Math.max(0, factSheetLineCount(agent, width, this.theme, this.terminalWidth) - height);
        this.factSheetOffset = Math.min(this.factSheetOffset, maximum);
    }
    scrollFactSheet(delta, agent) {
        const width = Math.max(1, this.nativeUi?.tui.terminal.columns ?? this.directoryRenderWidth ?? 80);
        const rows = Math.max(1, this.getTerminalRows());
        const height = Math.max(1, rows - 4);
        const maximum = Math.max(0, factSheetLineCount(agent, width, this.theme, this.terminalWidth) - height);
        this.factSheetOffset = Math.max(0, Math.min(maximum, this.factSheetOffset + delta));
    }
    openConversation(agent) {
        if (this.editorAgentId !== agent.agentId)
            this.editor?.setText('');
        this.editorAgentId = agent.agentId;
        this.conversationUnsubscribe?.();
        this.conversationUnsubscribe = undefined;
        this.selectedId = agent.agentId;
        this.selectedByView[this.directoryView] = agent.agentId;
        this.view = 'agent';
        this.factSheetOpen = false;
        this.pickerMarks = undefined;
        this.conversationTailOffset = 0;
        this.conversation = [];
        this.conversationEpoch = undefined;
        this.conversationIncarnation = undefined;
        this.conversationRevision = 0;
        this.conversationHydrated = false;
        this.setStatus(this.actions.subscribe ? { tone: 'muted', text: `Opening conversation for ${agent.handle}…` } : undefined, false);
        this.rebuildNativeComponents(agent);
        if (!this.actions.subscribe)
            return;
        try {
            this.conversationUnsubscribe = this.actions.subscribe(agent.agentId, (update) => this.applyConversationUpdate(agent, update));
        }
        catch (error) {
            this.setStatus({
                tone: 'error',
                text: `Could not open the conversation for ${agent.handle}: ${friendlyError(error)}. Return to the directory and try again.`,
            }, false);
        }
    }
    openAgent(agentId) {
        const agent = this.getProjection().directory.find((candidate) => candidate.agentId === agentId);
        if (!agent)
            throw new Error('The selected collaborator is no longer available');
        this.directoryView = agent.archived ? 'archived' : 'current';
        this.openConversation(agent);
        this.safeRender();
    }
    applyConversationUpdate(agent, update) {
        if (this.disposed || this.view !== 'agent' || this.selectedId !== agent.agentId || update.agentId !== agent.agentId)
            return;
        if (update.type === 'reset') {
            if (this.conversationEpoch === update.epoch && update.revision < this.conversationRevision)
                return;
            this.conversationEpoch = update.epoch;
            this.conversationIncarnation = update.incarnation;
            this.conversationRevision = update.revision;
            this.conversationHydrated = update.hydrated;
            this.conversation = [...update.messages];
            if (update.error)
                this.setStatus({
                    tone: 'error',
                    text: `Could not open the conversation for ${agent.handle}: ${friendlyError(update.error)}. Return to the directory and try again.`,
                }, false);
            else if (update.hydrated && this.status?.tone === 'muted' && this.status.text.startsWith('Opening conversation '))
                this.setStatus(undefined);
        }
        else {
            if (update.epoch !== this.conversationEpoch ||
                update.incarnation !== this.conversationIncarnation ||
                update.baseRevision !== this.conversationRevision ||
                update.start > this.conversation.length ||
                update.deleteCount > this.conversation.length - update.start)
                return;
            const messages = [...this.conversation];
            messages.splice(update.start, update.deleteCount, ...update.messages);
            this.conversation = messages;
            this.conversationRevision = update.revision;
            this.conversationHydrated = true;
        }
        this.rebuildNativeComponents(this.selectedAgent(this.getProjection()));
        this.clampScrollOffsets(this.getProjection());
        this.safeRender();
    }
    activateSelected(agent, projection) {
        if (agent.agentId !== projection.rootId) {
            this.openConversation(agent);
            return;
        }
        if (this.rootEnter === 'return') {
            this.disposed = true;
            this.done();
            return;
        }
        if (this.rootEnter === 'conversation') {
            this.openConversation(agent);
            return;
        }
        if (this.actions.palette)
            this.runAction(() => this.actions.palette?.(agent.agentId));
    }
    returnToDirectory(preserveReceipt = false) {
        this.conversationUnsubscribe?.();
        this.conversationUnsubscribe = undefined;
        this.view = 'directory';
        this.conversation = [];
        this.conversationHydrated = false;
        this.nativeGroups = [];
        this.nativeGroupWidth = 0;
        this.nativeLineTotal = undefined;
        if (!preserveReceipt || !this.status?.persistent)
            this.setStatus(undefined);
        this.safeRender();
    }
    scrollConversation(delta) {
        const projection = this.getProjection();
        const selected = this.selectedAgent(projection);
        this.conversationTailOffset = Math.min(this.conversationScrollMaximum(selected), Math.max(0, this.conversationTailOffset + delta));
        this.safeRender();
    }
    submitEditor(value, requestedMode) {
        if (this.busy)
            return;
        const projection = this.getProjection();
        this.reconcileProjection(projection);
        const agent = this.selectedAgent(projection);
        if (this.editorAgentId !== agent.agentId) {
            this.editor?.setText('');
            this.editorAgentId = agent.agentId;
            return;
        }
        const message = value.trim();
        if (!message) {
            this.setStatus({ tone: 'warning', text: 'Type a message first.' });
            this.safeRender();
            return;
        }
        if (message === `/${LUMINARIES_IDENTITY.command}`) {
            this.editor?.setText('');
            this.returnToDirectory();
            return;
        }
        if (agent.lifecycle === 'closed') {
            this.setStatus({ tone: 'muted', text: `${agent.handle} · Conversation kept. Use Resume collaborator first.` });
            this.safeRender();
            return;
        }
        this.run(() => this.actions.send(agent.agentId, message, requestedMode), (disposition) => {
            if (this.editor?.getText() === value)
                this.editor.setText('');
            this.conversationTailOffset = 0;
            return disposition === 'follow_up_queued'
                ? `Follow-up for ${agent.handle} was accepted for the next turn.`
                : disposition === 'steered'
                    ? `Message for ${agent.handle} was accepted for the active turn.`
                    : `Message for ${agent.handle} was accepted to start the next turn.`;
        });
    }
    clearOrInterrupt() {
        if (!this.editor)
            return;
        if (this.editor.getText()) {
            this.editor.setText('');
            this.safeRender();
            return;
        }
        const agent = this.selectedAgent(this.getProjection());
        if (!hasRunningTurn(agent)) {
            this.setStatus({ tone: 'muted', text: `${agent.handle} has no active turn to interrupt.` });
            this.safeRender();
            return;
        }
        this.runAction(async () => {
            const outcome = await this.actions.interrupt(agent.agentId);
            return outcome === 'already_finished'
                ? { tone: 'muted', persistent: true, text: `${agent.handle} already finished. Nothing was interrupted.` }
                : `Interrupted ${agent.handle}'s active turn.`;
        });
    }
    runAction(operation) {
        if (this.busy)
            return;
        this.busy = true;
        this.focused = false;
        this.setStatus({ tone: 'muted', text: 'Opening actions…' }, false);
        this.safeRender();
        void Promise.resolve()
            .then(operation)
            .then((result) => {
            if (this.disposed)
                return;
            this.busy = false;
            this.focused = true;
            const status = typeof result === 'string' ? { tone: 'success', text: result } : result;
            this.setStatus(status, status?.persistent !== true);
            this.safeRender();
        }, (error) => {
            if (this.disposed)
                return;
            this.busy = false;
            this.focused = true;
            // Errors persist until dismissed or superseded; the 4s TTL is for transient status.
            this.setStatus({ tone: 'error', text: friendlyError(error) }, false);
            this.safeRender();
        });
    }
    run(operation, success) {
        if (this.busy)
            return;
        this.busy = true;
        this.setStatus({ tone: 'muted', text: 'Submitting message…' }, false);
        this.safeRender();
        void operation().then((value) => {
            if (this.disposed)
                return;
            this.busy = false;
            this.setStatus({ tone: 'success', text: success(value) });
            this.safeRender();
        }, (error) => {
            if (this.disposed)
                return;
            this.busy = false;
            // Errors persist until dismissed or superseded; the 4s TTL is for transient status.
            this.setStatus({ tone: 'error', text: friendlyError(error) }, false);
            this.safeRender();
        });
    }
    setStatus(status, transient = true) {
        if (this.statusTimer)
            clearTimeout(this.statusTimer);
        this.statusTimer = undefined;
        this.status = status;
        this.clampScrollOffsets(this.getProjection());
        if (!status || !transient)
            return;
        this.statusTimer = setTimeout(() => {
            this.statusTimer = undefined;
            this.status = undefined;
            this.clampScrollOffsets(this.getProjection());
            this.safeRender();
        }, STATUS_TTL_MS);
        this.statusTimer.unref?.();
    }
    safeRender() {
        if (!this.disposed)
            this.requestRender();
    }
}
