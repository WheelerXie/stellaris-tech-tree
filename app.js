"use strict";

(() => {
  const areas = ["all", "physics", "society", "engineering", "event"];
  const logicLabels = { AND: "allOf", OR: "anyOf", NOT: "not", NOR: "noneOf", NAND: "notAllOf" };
  const cardWidth = 275;
  const cardHeight = 66;
  const columnSpacing = 325;
  const rowSpacing = 80;
  const padding = 10;
  const svgNamespace = "http://www.w3.org/2000/svg";
  const preferenceKey = "stellaris-tech-tree-language";

  const byId = (id) => document.getElementById(id);
  const tabs = byId("areas");
  const selector = byId("language");
  const tree = byId("tree");
  const dialog = byId("technology-details");
  const detailContent = byId("technology-content");
  const status = byId("status");

  const loadedLocales = new Map();
  let snapshot;
  let manifest;
  let technologies;
  let geometry;
  let images;
  let area = "all";
  let selectedId = null;
  let language;
  let pack;
  let english;
  let englishRequested = false;
  let languageRequest = 0;
  let numberFormat;
  let listFormat;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(url + " returned " + response.status);
    return response.json();
  }

  function loadLocale(code) {
    if (!loadedLocales.has(code)) {
      const promise = snapshot
        ? Promise.resolve(snapshot.locales[code])
        : getJson("./locales/" + encodeURIComponent(code) + ".json");
      loadedLocales.set(code, promise.catch((error) => {
        loadedLocales.delete(code);
        throw error;
      }));
    }
    return loadedLocales.get(code);
  }

  function preferredLocale() {
    const codes = new Map(manifest.locales.map(({ code }) => [code.toLowerCase(), code]));
    let stored;
    try {
      stored = localStorage.getItem(preferenceKey);
    } catch {
      // A file:// viewer can browse even when the browser disables local storage.
    }
    if (stored && codes.has(stored.toLowerCase())) return codes.get(stored.toLowerCase());
    for (const requested of navigator.languages || [navigator.language]) {
      const tag = requested.toLowerCase();
      if (codes.has(tag)) return codes.get(tag);
      const base = tag.split("-")[0];
      if (codes.has(base)) return codes.get(base);
      if (base === "zh" && codes.has("zh-hans")) return codes.get("zh-hans");
      if (base === "pt" && codes.has("pt-br")) return codes.get("pt-br");
    }
    return "en";
  }

  function ui(key) {
    return pack?.ui[key] ?? key;
  }

  function text(key) {
    if (Object.hasOwn(pack.text, key)) return pack.text[key];
    if (english && Object.hasOwn(english.text, key)) return english.text[key];
    if (language !== "en" && !englishRequested && !english) {
      englishRequested = true;
      loadLocale("en").then((fallback) => {
        english = fallback;
        if (language !== "en") drawContent();
      }).catch((error) => console.warn(error));
    }
    return key;
  }

  async function changeLanguage(code, savePreference) {
    const request = ++languageRequest;
    let nextPack;
    try {
      nextPack = await loadLocale(code);
    } catch (error) {
      if (request !== languageRequest) return;
      if (pack) {
        selector.value = language;
        setStatus(ui("languageFailed"));
        return;
      }
      if (code === "en") throw error;
      code = "en";
      nextPack = await loadLocale(code);
    }
    if (request !== languageRequest) return;

    pack = nextPack;
    language = code;
    if (code === "en") english = pack;
    if (!english) englishRequested = false;
    selector.value = code;
    document.documentElement.lang = code;
    numberFormat = new Intl.NumberFormat(code, { maximumFractionDigits: 6 });
    listFormat = new Intl.ListFormat(code);
    if (savePreference) {
      try {
        localStorage.setItem(preferenceKey, code);
      } catch {
        // Storage is optional for this session.
      }
    }

    document.title = ui("title");
    tabs.setAttribute("aria-label", ui("researchAreas"));
    byId("language-label").textContent = ui("language");
    byId("close-details").setAttribute("aria-label", ui("close"));
    byId("offline-download").textContent = ui("download");
    setStatus();
    drawContent();
  }

  function setStatus(message) {
    status.textContent = message || "";
    status.hidden = !message;
  }

  function imageUrl(stem) {
    const key = stem.toLowerCase();
    const name = images.has(key) ? key : "placeholder";
    return "./image/" + encodeURIComponent(name) + ".png";
  }

  function icon(stem, className) {
    const image = node("img", undefined, className);
    image.alt = "";
    image.loading = "lazy";
    image.src = imageUrl(stem);
    image.addEventListener("error", () => {
      if (stem !== "placeholder") image.src = imageUrl("placeholder");
    }, { once: true });
    return image;
  }

  function indexRelations() {
    const children = new Map();
    const referencedBy = new Map();
    const roots = [];
    for (const id of technologies.keys()) {
      children.set(id, []);
      referencedBy.set(id, []);
    }
    for (const [id, technology] of technologies) {
      const parent = children.get(technology.primaryParent);
      if (parent) parent.push(id);
      else roots.push(id);

      const references = new Set();
      collectReferences(technology.prerequisites, references);
      for (const prerequisite of references) referencedBy.get(prerequisite)?.push(id);
    }
    return {
      groups: roots.map((id) => arrangeGroup(id, children)),
      referencedBy
    };
  }

  function collectReferences(prerequisite, references) {
    if (!prerequisite) return;
    if (prerequisite.id) references.add(prerequisite.id);
    else for (const item of prerequisite.items) collectReferences(item, references);
  }

  function arrangeGroup(root, children) {
    const points = [];
    const edges = [];
    const researchAreas = new Set();
    let row = 0;
    let depth = 0;
    arrange(root, 0);
    const rootTechnology = technologies.get(root);
    return {
      root, points, edges, researchAreas, depth,
      width: cardWidth + columnSpacing * depth + 2 * padding,
      height: row * rowSpacing + 2 * padding,
      event: points.length === 1 && rootTechnology.baseWeight === 0
        && !rootTechnology.prerequisites && !rootTechnology.isStartTech
    };

    function arrange(id, column) {
      const point = { id, x: padding + column * columnSpacing, y: 0 };
      points.push(point);
      researchAreas.add(technologies.get(id).area);
      depth = Math.max(depth, column);
      const branches = children.get(id).map((child) => arrange(child, column + 1));
      if (branches.length === 0) {
        point.y = padding + row++ * rowSpacing;
      } else {
        point.y = (branches[0].y + branches[branches.length - 1].y) / 2;
        for (const branch of branches) edges.push([point, branch]);
      }
      return point;
    }
  }

  function drawContent() {
    drawTabs();
    drawTree();
    if (selectedId) drawDetails();
  }

  function drawTabs() {
    const buttons = areas.map((key) => {
      const button = node("button", ui(key), "tab");
      button.type = "button";
      button.dataset.area = key;
      button.setAttribute("aria-pressed", String(key === area));
      if (key !== "all" && key !== "event") button.append(icon(key + "_research"));
      return button;
    });
    tabs.replaceChildren(...buttons);
  }

  function drawTree() {
    const groups = geometry.groups
      .filter((group) => area === "event" ? group.event
        : !group.event && (area === "all" || group.researchAreas.has(area)))
      .sort((first, second) => {
        const firstMatches = technologies.get(first.root).area === area;
        const secondMatches = technologies.get(second.root).area === area;
        return Number(secondMatches) - Number(firstMatches)
          || second.depth - first.depth || second.points.length - first.points.length;
      });
    const content = document.createDocumentFragment();
    if (groups.length === 0) content.append(node("p", ui("empty"), "empty"));
    for (const group of groups) {
      const wrapper = node("div", undefined, "group");
      wrapper.style.width = group.width + "px";
      wrapper.style.height = group.height + "px";
      if (group.edges.length) wrapper.append(drawEdges(group));
      for (const point of group.points) wrapper.append(drawCard(point));
      content.append(wrapper);
    }
    tree.replaceChildren(content);
  }

  function drawEdges(group) {
    const svg = document.createElementNS(svgNamespace, "svg");
    svg.classList.add("links");
    svg.setAttribute("width", group.width);
    svg.setAttribute("height", group.height);
    svg.setAttribute("aria-hidden", "true");
    for (const [parent, child] of group.edges) {
      const start = parent.x + cardWidth;
      const middle = (start + child.x) / 2;
      const sourceY = parent.y + cardHeight / 2;
      const targetY = child.y + cardHeight / 2;
      const path = document.createElementNS(svgNamespace, "path");
      path.setAttribute("d", ["M", start, sourceY, "H", middle, "V", targetY, "H", child.x].join(" "));
      svg.append(path);
    }
    return svg;
  }

  function drawCard({ id, x, y }) {
    const technology = technologies.get(id);
    const card = node("button", undefined, "technology " + technology.area);
    card.type = "button";
    card.id = id;
    card.dataset.tech = id;
    card.style.left = x + "px";
    card.style.top = y + "px";
    card.setAttribute("aria-haspopup", "dialog");
    const background = "tech_bg_" + (technology.isDangerous ? "dangerous"
      : technology.isRare ? "rare" : technology.area);
    if (images.has(background)) card.style.backgroundImage = 'url("' + imageUrl(background) + '")';

    const name = text(id);
    card.title = name;
    card.append(icon(technology.icon, "tech-icon"));
    const content = node("span", undefined, "card-text");
    content.append(node("span", name, "caption"));
    const category = node("span", undefined, "card-category");
    const firstCategory = technology.categories[0];
    if (firstCategory) {
      category.append(icon("category_" + firstCategory));
      category.append(node("span", text(firstCategory)));
    }
    const tier = technology.isStartTech ? ui("start")
      : technology.tier === undefined ? "—" : "T" + number(technology.tier);
    if (firstCategory) category.append(node("span", "·"));
    category.append(node("span", tier));
    content.append(category);
    if (!technology.isStartTech) {
      const metrics = ui("baseCost") + " " + number(technology.baseCost)
        + " · " + ui("baseWeight") + " " + number(technology.baseWeight);
      const line = node("span", metrics, "card-metrics");
      line.title = metrics;
      content.append(line);
    }
    card.append(content);
    return card;
  }

  function number(value) {
    return value == null ? "—" : numberFormat.format(value);
  }

  function fragmentId() {
    try {
      return decodeURIComponent(location.hash.slice(1));
    } catch {
      return "";
    }
  }

  function openDetails(id, jump, updateLocation) {
    if (!technologies.has(id)) return;
    selectedId = id;
    if (updateLocation && fragmentId() !== id) {
      history.pushState(null, "", "#" + encodeURIComponent(id));
    }
    if (jump) {
      const targetArea = geometry.groups.some((group) => group.event && group.root === id)
        ? "event" : technologies.get(id).area;
      if (targetArea !== area) {
        area = targetArea;
        drawTabs();
        drawTree();
      }
      byId(id)?.scrollIntoView({ block: "center", inline: "center" });
    }
    drawDetails();
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    byId("close-details").focus();
  }

  function drawDetails() {
    const id = selectedId;
    const technology = technologies.get(id);
    byId("technology-title").textContent = text(id);
    const facts = node("dl", undefined, "facts");
    const addFact = (key, value) => facts.append(node("dt", ui(key)), node("dd", value));
    addFact("categories", technology.categories.length
      ? listFormat.format(technology.categories.map(text)) : ui("none"));
    addFact("tier", technology.isStartTech ? ui("start") : number(technology.tier));
    addFact("baseCost", number(technology.baseCost));
    addFact("baseWeight", number(technology.baseWeight));
    if (technology.levels !== undefined) {
      addFact("levels", technology.levels < 0 ? ui("unlimited") : number(technology.levels));
    }
    if (technology.costPerLevel !== undefined) addFact("costPerLevel", number(technology.costPerLevel));

    const relations = node("section", undefined, "relations");
    const requirements = node("div");
    requirements.id = "tech-prerequisites";
    requirements.append(node("h2", ui("prerequisites")));
    requirements.append(technology.prerequisites ? drawPrerequisite(technology.prerequisites) : node("p", ui("none")));
    relations.append(requirements, node("h2", ui("usedBy")));
    const references = geometry.referencedBy.get(id);
    relations.append(references.length ? list(references.map(technologyLink)) : node("p", ui("none")));

    detailContent.replaceChildren(node("p", text(id + "_desc"), "description"),
      node("div", id, "tech-id"), facts, relations);
    const scripts = Object.values(technology.rules);
    if (scripts.length) {
      const rules = node("details");
      rules.append(node("summary", ui("scriptRules")), node("pre", scripts.join("\n\n")));
      detailContent.append(rules);
    }
    if (technology.variants.length) detailContent.append(drawVariants(technology.variants));
  }

  function drawVariants(variants) {
    const details = node("details");
    details.append(node("summary", ui("variants")));
    for (const variant of variants) {
      const title = node("h3", undefined, "variant-title");
      title.append(icon(variant.icon), node("span", text(variant.name)));
      details.append(title, node("p", text(variant.name + "_desc"), "description"));
      const metadata = [];
      if (variant.area) metadata.push(ui(variant.area));
      metadata.push(...variant.categories.map(text));
      if (metadata.length) details.append(node("p", listFormat.format(metadata)));
      details.append(node("pre", variant.script));
    }
    return details;
  }

  function technologyLink(id) {
    if (!technologies.has(id)) {
      const missing = node("span", id, "missing");
      missing.title = ui("missingTech");
      return missing;
    }
    const link = node("a", text(id));
    link.href = "#" + encodeURIComponent(id);
    link.dataset.relatedTech = id;
    return link;
  }

  function drawPrerequisite(prerequisite) {
    if (prerequisite.id) return technologyLink(prerequisite.id);
    const group = node("div");
    group.dataset.operation = prerequisite.op;
    group.append(node("span", ui(logicLabels[prerequisite.op]), "logic-label"));
    group.append(list(prerequisite.items.map(drawPrerequisite)));
    return group;
  }

  function list(items) {
    const result = node("ul");
    for (const item of items) {
      const row = node("li");
      row.append(item);
      result.append(row);
    }
    return result;
  }

  function onLocationChange() {
    const id = fragmentId();
    if (technologies.has(id)) openDetails(id, true, false);
    else if (dialog.open) dialog.close();
  }

  async function start() {
    const embedded = byId("embedded-data");
    snapshot = embedded ? JSON.parse(embedded.textContent) : null;
    let data;
    if (snapshot) {
      manifest = snapshot.manifest;
      data = snapshot.technologies;
    } else {
      [manifest, data] = await Promise.all([getJson("./manifest.json"), getJson("./technologies.json")]);
    }
    if (manifest.schemaVersion !== 1) throw new Error("Unsupported technology data version");

    technologies = new Map(Object.entries(data));
    images = new Set(manifest.images);
    geometry = indexRelations();
    for (const { code, name } of manifest.locales) {
      const option = node("option", name);
      option.value = code;
      option.lang = code;
      selector.append(option);
    }
    const checksum = manifest.gameChecksum ? " (" + manifest.gameChecksum + ")" : "";
    byId("version").textContent = "Stellaris " + manifest.gameVersion + checksum;
    if (!snapshot) {
      const download = byId("offline-download");
      download.href = "./" + encodeURIComponent(manifest.offlineDownload);
      download.download = manifest.offlineDownload;
      download.hidden = false;
    }
    await changeLanguage(preferredLocale(), false);
    selector.disabled = false;
    byId("main").setAttribute("aria-busy", "false");
    onLocationChange();
    window.addEventListener("hashchange", onLocationChange);
  }

  selector.addEventListener("change", () => changeLanguage(selector.value, true));
  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-area]");
    if (!tab || tab.dataset.area === area) return;
    area = tab.dataset.area;
    drawTabs();
    drawTree();
    tabs.querySelector('[aria-pressed="true"]').focus();
  });
  tree.addEventListener("click", (event) => {
    const card = event.target.closest("[data-tech]");
    if (card) openDetails(card.dataset.tech, false, true);
  });
  detailContent.addEventListener("click", (event) => {
    const link = event.target.closest("[data-related-tech]");
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openDetails(link.dataset.relatedTech, true, true);
  });
  byId("close-details").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    if (selectedId === fragmentId()) history.replaceState(null, "", location.href.split("#")[0]);
    byId(selectedId)?.focus({ preventScroll: true });
    selectedId = null;
  });

  start().catch((error) => {
    setStatus(pack ? ui("loadFailed") : "Could not load the technology tree. Reload the page to try again.");
    byId("main").setAttribute("aria-busy", "false");
    console.error(error);
  });
})();
