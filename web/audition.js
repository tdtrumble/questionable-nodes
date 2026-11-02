import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function element(tag, text, parent) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    parent?.append(item);
    return item;
}

function button(text, parent, action) {
    const item = element("button", text, parent);
    item.addEventListener("click", action);
    return item;
}

function panelFor(node, name) {
    const panel = element("div");
    Object.assign(panel.style, { overflowY: "auto", padding: "8px", boxSizing: "border-box",
        background: "var(--comfy-input-bg, #222)", color: "var(--input-text, #ddd)", font: "13px sans-serif" });
    node.addDOMWidget(name, "div", panel, { serialize: false, getMinHeight: () => 240, getMaxHeight: () => 1200 });
    return panel;
}

function promptEditor(node) {
    const widget = node.widgets.find(item => item.name === "prompts");
    widget.type = "converted-widget";
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    const panel = panelFor(node, "prompt_editor");
    const read = () => JSON.parse(widget.value);
    function write(values) {
        widget.value = JSON.stringify(values);
        node.setDirtyCanvas(true, true);
    }
    function render() {
        panel.replaceChildren();
        const values = read();
        values.forEach((value, index) => {
            const row = element("div", undefined, panel);
            row.style.marginBottom = "10px";
            const actions = element("div", `Prompt ${index + 1} `, row);
            for (const [label, direction] of [["↑", -1], ["↓", 1]]) {
                const move = button(label, actions, () => {
                    const current = read();
                    const target = index + direction;
                    [current[index], current[target]] = [current[target], current[index]];
                    write(current);
                    render();
                });
                move.disabled = index + direction < 0 || index + direction >= values.length;
            }
            button("Remove", actions, () => {
                const current = read();
                current.splice(index, 1);
                write(current);
                render();
            });
            const input = element("textarea", undefined, row);
            input.value = value;
            input.placeholder = "Enter a prompt (multiple lines are supported)";
            input.rows = 4;
            Object.assign(input.style, { width: "100%", boxSizing: "border-box", resize: "vertical" });
            input.addEventListener("input", () => {
                const current = read();
                current[index] = input.value;
                write(current);
            });
        });
        button("Add prompt", panel, () => { write([...read(), ""]); render(); });
    }
    const configure = node.onConfigure;
    node.onConfigure = function () { configure?.apply(this, arguments); render(); };
    render();
    node.setSize([440, 500]);
}

function reviewPanel(node) {
    const sessionWidget = node.widgets.find(item => item.name === "session");
    const panel = panelFor(node, "audition_review");
    const actions = element("div", undefined, panel);
    const status = element("div", "Run an audition or load a saved session.", panel);
    status.setAttribute("role", "status");
    const filter = element("select", undefined, panel);
    filter.setAttribute("aria-label", "Candidate set filter");
    const table = element("div", undefined, panel);
    const cards = element("div", undefined, panel);
    let document = null;
    let votes = {};
    let requestId = 0;
    function setKey(card) { return card.candidates.map(item => item.id).sort().join(":"); }
    function renderRanking() {
        table.replaceChildren();
        const ranking = document?.rankings[filter.value] ?? [];
        const grid = element("table", undefined, table);
        grid.style.width = "100%";
        const header = element("tr", undefined, grid);
        for (const title of ["Rank", "Checkpoint", "Selected", "Entered"]) element("th", title, header);
        for (const score of ranking) {
            const row = element("tr", undefined, grid);
            for (const value of [score.rank, `${score.name} (${score.id.slice(0, 8)})`, score.wins, score.entered]) {
                element("td", String(value), row);
            }
        }
    }
    function renderCards() {
        cards.replaceChildren();
        for (const card of document?.cards ?? []) {
            if (filter.value !== "all" && setKey(card) !== filter.value) continue;
            const box = element("div", undefined, cards);
            Object.assign(box.style, { borderTop: "1px solid #666", padding: "12px 0" });
            const prompt = element("div", card.prompt, box);
            prompt.style.whiteSpace = "pre-wrap";
            element("small", `Seed ${card.seed} · Sample ${card.sample} · Run ${card.run.slice(0, 8)}`, box);
            const image = element("img", undefined, box);
            Object.assign(image.style, { width: "100%", maxHeight: "480px", objectFit: "contain", display: "block" });
            const slider = element("input", undefined, box);
            slider.type = "range";
            slider.min = 0;
            slider.max = card.candidates.length - 1;
            slider.step = 1;
            const selected = Object.hasOwn(votes, card.id) ? votes[card.id] : card.winner;
            slider.value = Math.max(0, card.candidates.findIndex(item => item.id === selected));
            slider.style.width = "100%";
            slider.setAttribute("aria-label", "LoRA checkpoint");
            const label = element("div", undefined, box);
            const choice = element("div", undefined, box);
            function show() {
                const candidate = card.candidates[Number(slider.value)];
                image.src = api.apiURL("/view?" + new URLSearchParams(candidate.image));
                image.alt = `${card.prompt} — ${candidate.name}`;
                label.textContent = `${Number(slider.value) + 1} / ${card.candidates.length} — ${candidate.name}`;
            }
            function choiceText() {
                const winner = Object.hasOwn(votes, card.id) ? votes[card.id] : card.winner;
                const name = card.candidates.find(item => item.id === winner)?.name;
                choice.textContent = name ? `Chosen: ${name}` : "Unscored / skipped";
            }
            slider.addEventListener("input", show);
            button("Choose this", box, () => {
                votes[card.id] = card.candidates[Number(slider.value)].id;
                choiceText();
                status.textContent = "Choices changed. Click Update ranking to save.";
            });
            button("Skip", box, () => {
                votes[card.id] = null;
                choiceText();
                status.textContent = "Choices changed. Click Update ranking to save.";
            });
            show();
            choiceText();
        }
    }
    function accept(value, preserveVotes = false) {
        document = value;
        if (!preserveVotes) votes = {};
        const previous = filter.value;
        filter.replaceChildren();
        const all = element("option", "All runs", filter);
        all.value = "all";
        const groups = [...new Set(value.cards.map(setKey))];
        groups.forEach((group, index) => {
            const option = element("option", `Candidate set ${index + 1}`, filter);
            option.value = group;
        });
        filter.value = previous === "all" || groups.includes(previous) ? previous : "all";
        renderRanking();
        renderCards();
        status.textContent = `${value.cards.length} comparisons loaded. ${Object.keys(votes).length ? "Unsaved choices retained." : "Choices saved."}`;
    }
    async function request(route, payload) {
        const id = ++requestId;
        const name = sessionWidget.value;
        status.textContent = "Loading…";
        panel.inert = true;
        try {
            const response = await api.fetchApi(`/questionable-nodes/audition/${route}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...payload }),
            });
            const value = await response.json();
            if (id !== requestId || name !== sessionWidget.value) return;
            if (!response.ok) throw new Error(value.error ?? "Session request failed.");
            accept(value);
        } catch (error) {
            if (id === requestId) status.textContent = error.message;
        } finally {
            panel.inert = false;
        }
    }
    button("Load session", actions, () => request("session", {}));
    button("Update ranking", actions, () => request("votes", { votes: { ...votes } }));
    filter.addEventListener("change", () => { renderRanking(); renderCards(); });
    const callback = sessionWidget.callback;
    sessionWidget.callback = function () {
        callback?.apply(this, arguments);
        requestId++;
        document = null;
        votes = {};
        cards.replaceChildren();
        table.replaceChildren();
        status.textContent = "Run an audition or load this session.";
    };
    const executed = node.onExecuted;
    node.onExecuted = function (message) {
        executed?.apply(this, arguments);
        const value = message.audition_session?.[0];
        if (value && value.name === sessionWidget.value.trim()) {
            requestId++;
            accept(value, true);
        }
    };
    const configure = node.onConfigure;
    node.onConfigure = function () { configure?.apply(this, arguments); request("session", {}); };
    node.setSize([560, 780]);
}

app.registerExtension({
    name: "questionable-nodes.audition",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const setup = { QuestionableAuditionPromptList: promptEditor, QuestionableAuditionReview: reviewPanel }[nodeData.name];
        if (!setup) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            setup(this);
            return result;
        };
    },
});
