/**
 * PF2E - Throw Weapon
 *
 * Escucha los mensajes de ataque (Strike) del sistema PF2e. Si el ataque fue un lanzamiento
 * (opcion de tirada `item:thrown`) y el arma pertenece a un actor:
 *   - ACIERTA (success / criticalSuccess)  -> el arma pasa al inventario del actor objetivo.
 *   - FALLA (failure / criticalFailure)    -> el arma queda en el piso (Item Pile en la casilla del objetivo).
 *   - Sin objetivo o sin resultado         -> pregunta al jugador que paso.
 * Siempre se resta 1 del monton del lanzador (si era la ultima, el item se borra).
 *
 * Todo ocurre DESPUES de que termine la animacion de Dice So Nice (si esta activo), para no adelantar
 * el resultado del dado. El aviso es un toast arriba (lanzador y GMs), no una tarjeta en el chat.
 *
 * Excepciones:
 *   - Runa `returning` o rasgo `tethered`: el arma vuelve a la mano, no se toca nada.
 *   - Rasgo `recovery`: si falla, vuelve a la mano; si acierta, va al objetivo.
 *   - flags.pf2e-throw-weapon.mode en el item: "ignore" (no hacer nada) o "consume" (solo restar 1,
 *     sin mover nada).
 *
 * Al lanzar, el arma sale de la mano: si el monton sigue equipado en la mano ("held"), pasa a "worn"
 * (desequipado) aunque queden unidades; hay que volver a sacar una para lanzar otra.
 *
 * Mover items entre actores y crear tokens en la escena requiere permisos de GM: se delega en la API
 * de Item Piles, que ya lo hace por socket.
 */

const ID = "pf2e-throw-weapon";
const HOLDER_TYPES = ["character", "npc", "loot"];
const HIT = ["success", "criticalSuccess"];
const MISS = ["failure", "criticalFailure"];
const REQUIRED = { "item-piles": "Item Piles", "itempiles-pf2e": "Item Piles: PF2e" };

Hooks.once("init", () => {
  // API para otros modulos (p. ej. PF2E - Fane's Fourberie esparce el mazo con Fane's Escape).
  game.modules.get(ID).api = {
    dropToFloor: async (tokenDoc, data, item = null) => {
      if (!piles()) throw new Error("Faltan Item Piles / Item Piles: PF2e");
      return dropToFloor(tokenDoc, data, tokenDoc, item);
    },
  };
  const reg = (key, name, hint, def) =>
    game.settings.register(ID, key, { name, hint, scope: "world", config: true, type: Boolean, default: def });
  reg("hitToTarget", "Al acertar, el arma pasa al objetivo", "Si esta desactivado, un arma que acierta se pierde (solo se resta del lanzador).", true);
  reg("missToFloor", "Al fallar, el arma queda en el piso", "Crea (o completa) un Item Pile en una casilla contigua al objetivo. Si esta desactivado, un arma que falla se pierde.", true);
  reg("unequip", "Desequipar el monton al lanzar", "Lanzar un arma la saca de la mano: si el monton estaba en la mano ('held'), pasa a 'worn' aunque queden unidades.", true);
  reg("animations", "Animaciones de lanzamiento", "Solo si Sequencer esta activo (los proyectiles ademas usan JB2A): proyectil de carta para las cartas de Fane's Fourberie, proyectil de reemplazo si no hay animacion adecuada, y animacion de caida al piso.", true);
  reg("replaceMelee", "Reemplazar el golpe cuerpo a cuerpo de Automated Animations", "Si un arma lanzada con proyectil similar (lanza, cuchillo arrojadizo) recibe de Automated Animations una animacion de golpe cuerpo a cuerpo, se cambia por un proyectil.", true);
  game.settings.register(ID, "notify", {
    name: "Aviso del resultado",
    hint: "Como se avisa a donde fue el arma. 'Arriba' no agrega nada al chat.",
    scope: "world",
    config: true,
    type: String,
    default: "toast",
    choices: {
      toast: "Mensaje arriba (lanzador y GMs)",
      gm: "Tarjeta de chat solo para el GM",
      chat: "Tarjeta de chat publica",
      off: "Sin aviso",
    },
  });
});

Hooks.once("ready", () => {
  game.socket.on(`module.${ID}`, (data) => {
    if (game.user.isGM && data?.text) ui.notifications.info(data.text);
  });
  if (game.user.isGM && missingDeps().length) warnDeps();
  if (game.modules.get("sequencer")?.active) Hooks.on("createSequencerEffect", onSequencerEffect);
});

// Las cartas de Fane's Fourberie llevan flags.pf2e-throw-weapon.animation = "card": se les apaga la animacion
// automatica de Automated Animations (que mostraria una daga) porque este modulo reproduce la de carta.
// AA ignora flags sin `version` igual o mayor a su esquema (5), por eso se escribe junto con killAnim.
const AA_FLAGS_VERSION = 5;
Hooks.on("preCreateItem", (item, data) => {
  if (data?.flags?.[ID]?.animation !== "card" || !animOn() || !hasPath(PATHS.card)) return;
  item.updateSource({ "flags.autoanimations": { version: AA_FLAGS_VERSION, killAnim: true } });
});

Hooks.on("createChatMessage", (message, _options, userId) => {
  if (userId !== game.user.id) return; // solo el cliente de quien tiro procesa el mensaje
  handleAttack(message).catch((e) => {
    console.error(`${ID} |`, e);
    ui.notifications.error("PF2E - Throw Weapon: error, mira la consola (F12).");
  });
});

const setting = (k) => game.settings.get(ID, k);
const missingDeps = () => Object.keys(REQUIRED).filter((id) => !game.modules.get(id)?.active);
const piles = () => (missingDeps().length ? null : game.itempiles?.API ?? null);

let warned = false;
function warnDeps() {
  if (warned) return;
  warned = true;
  const names = missingDeps().map((id) => REQUIRED[id]).join(" y ");
  ui.notifications.error(`PF2E - Throw Weapon necesita activar: ${names}. Mientras tanto no se mueve ninguna arma.`, { permanent: true });
}

async function handleAttack(message) {
  const ctx = message.flags?.pf2e?.context;
  if (ctx?.type !== "attack-roll") return;
  if (!(ctx.options ?? []).includes("item:thrown")) return;

  const item = message.item ?? (await fromUuid(message.flags.pf2e.origin?.uuid));
  if (!item || item.type !== "weapon" || !(item.parent instanceof Actor)) return;
  const actor = item.parent;
  if (!actor.isOwner) return;

  const mode = item.flags?.[ID]?.mode;
  if (mode === "ignore") return;

  const traits = item.system.traits?.value ?? [];
  const runes = item.system.runes?.property ?? [];
  if (runes.includes("returning") || traits.includes("tethered")) return;

  // Sin los modulos de Item Piles no se puede mover nada: no tocar el inventario (solo "consume" funciona).
  if (mode !== "consume" && !piles()) {
    warnDeps();
    return;
  }

  // Esperar la animacion de Dice So Nice antes de actuar o avisar (no adelantar el resultado).
  // Solo si la pestana esta visible (en segundo plano la animacion no corre) y con tope de 15 s.
  const seenAt = performance.now();
  const outcome = ctx.outcome ?? null;
  const targetToken = ctx.target?.token ? await fromUuid(ctx.target.token) : null;
  const thrower = actorToken(actor, message);
  const kind = projectileKind(item);
  // Antes de esperar el dado: si Automated Animations pone un golpe cuerpo a cuerpo a un arma lanzada, se reemplaza.
  if (targetToken && kind && kind !== "card" && animOn() && setting("replaceMelee")) markPending(targetToken.id);

  if (game.dice3d?.waitFor3DAnimationByMessageID && document.visibilityState === "visible") {
    try {
      await Promise.race([
        game.dice3d.waitFor3DAnimationByMessageID(message.id),
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ]);
    } catch (_e) {
      /* sin animacion para este mensaje */
    }
  }

  // Proyectil propio (solo si Automated Animations no animo ya este lanzamiento, o para las cartas).
  await playProjectile({ kind, thrower, targetToken, seenAt });
  let action;
  if (mode === "consume") action = "lost";
  else if (targetToken && outcome) action = HIT.includes(outcome) ? "hit" : MISS.includes(outcome) ? "miss" : "ask";
  else action = "ask";

  if (action === "ask") action = await ask(item, targetToken);
  console.log(`${ID} | lanzamiento: ${item.name} (id ${item.id}) outcome=${outcome} objetivo=${targetToken?.name ?? "ninguno"} modo=${mode ?? "normal"} accion=${action}`);
  if (!action || action === "none") return;

  if (action === "miss" && traits.includes("recovery")) {
    notify(actor, item, "falla y el arma vuelve a su mano (recovery)");
    return;
  }

  const data = item.toObject();
  delete data._id;
  data.system.quantity = 1;
  if (data.flags) delete data.flags[ID];

  let result;
  if (action === "hit") {
    const holder = targetToken?.actor;
    if (setting("hitToTarget") && holder?.isOfType(...HOLDER_TYPES)) {
      data.system.equipped = { carryType: "stowed", handsHeld: 0 };
      await piles().addItems(holder, [{ item: data, quantity: 1 }]);
      result = `acierta: pasa al inventario de ${targetToken.name}`;
    } else if (setting("missToFloor") && targetToken) {
      await dropToFloor(targetToken, data, thrower, item);
      result = `acierta, pero ${targetToken.name} no puede llevarla: cae al piso`;
    } else result = "acierta y el arma se pierde";
  } else if (action === "miss") {
    const where = targetToken ?? thrower;
    if (setting("missToFloor") && where) {
      await dropToFloor(where, data, thrower, item);
      result = targetToken ? `falla: cae al piso junto a ${targetToken.name}` : "cae al piso junto al lanzador";
    } else result = "falla y el arma se pierde";
  } else if (action === "floor") {
    if (thrower) {
      await dropToFloor(thrower, data, thrower, item);
      result = "cae al piso junto al lanzador";
    } else result = "el arma se pierde";
  } else result = mode === "consume" ? "se gasta (1 menos en el monton)" : "el arma se pierde";

  await consume(item);
  notify(actor, item, result);
}

/** Resta 1 del monton y lo desequipa (el arma lanzada sale de la mano); si era el ultimo, borra el item. */
async function consume(item) {
  const q = item.system.quantity ?? 1;
  if (q <= 1) {
    await item.delete();
    return;
  }
  const update = { "system.quantity": q - 1 };
  if (setting("unequip") && item.system.equipped?.carryType === "held") {
    update["system.equipped.carryType"] = "worn";
    update["system.equipped.handsHeld"] = 0;
  }
  await item.update(update);
}

function actorToken(actor, message) {
  const id = message.speaker?.token;
  return (id && canvas.scene?.tokens.get(id)) || actor.getActiveTokens()[0]?.document || null;
}

/**
 * Deja el arma en el piso como Item Pile, SIEMPRE al lado del token (una de las 4 casillas contiguas):
 *   1. Si ya hay un pile en una de esas casillas (o en la del propio token), el arma se suma a ese pile.
 *   2. Si no, crea uno nuevo en una casilla contigua libre (sin tokens y, de preferencia, sin muro de por
 *      medio); entre varias libres elige la mas cercana al lanzador. Si todas estan ocupadas, usa la del token.
 */
async function dropToFloor(tokenDoc, data, throwerToken = null, item = null) {
  const scene = tokenDoc.parent;
  const api = piles();
  const size = scene.grid.size;
  data.system.equipped = { carryType: "dropped", handsHeld: 0 };

  const own = { x: tokenDoc.x, y: tokenDoc.y };
  const cands = adjacentCells(tokenDoc, size);

  const existing = scene.tokens.find(
    (t) => t.id !== tokenDoc.id && [...cands, own].some((c) => c.x === t.x && c.y === t.y) && api.isValidItemPile(t)
  );
  if (existing) {
    await playLanding(item, tokenDoc, existing);
    await api.addItems(existing, [{ item: data, quantity: 1 }]);
    console.log(`${ID} | pila existente reutilizada: token id=${existing.id} uuid=${existing.uuid} en (${existing.x},${existing.y})`);
    return existing.uuid;
  }

  const from = throwerToken ?? tokenDoc;
  const dist = (c) => Math.hypot(c.x - from.x, c.y - from.y);
  const free = cands.filter((c) => insideScene(scene, c, size) && !occupied(scene, c, size)).sort((a, b) => dist(a) - dist(b));
  const clear = free.filter((c) => !wallBetween(tokenDoc, c, size));
  const spot = clear[0] ?? free[0] ?? own;

  await playLanding(item, tokenDoc, spot);
  const res = await api.createItemPile({ position: { x: spot.x, y: spot.y }, sceneId: scene.id, items: [data] });
  const tokenUuid = res?.tokenUuid ?? null;
  console.log(
    `${ID} | pila creada: token id=${tokenUuid ? tokenUuid.split(".").pop() : "(sin id)"} uuid=${tokenUuid} ` +
      `actor=${res?.actorUuid} en (${spot.x},${spot.y}); libres=${free.length}, sin muro=${clear.length}`,
    res
  );
  if (!tokenUuid) {
    console.warn(`${ID} | createItemPile no devolvio token (respuesta: ${JSON.stringify(res)}); el arma NO se resta.`);
    throw new Error("Item Piles no creo la pila");
  }
  return tokenUuid;
}

/** Casillas (esquina superior izquierda) contiguas por los 4 lados del token (soporta tokens de varias casillas). */
function adjacentCells(t, size) {
  const w = Math.max(1, Math.round(t.width));
  const h = Math.max(1, Math.round(t.height));
  const cells = [];
  for (let k = 0; k < h; k++) {
    cells.push({ x: t.x - size, y: t.y + k * size }, { x: t.x + w * size, y: t.y + k * size });
  }
  for (let k = 0; k < w; k++) {
    cells.push({ x: t.x + k * size, y: t.y - size }, { x: t.x + k * size, y: t.y + h * size });
  }
  return cells;
}

function insideScene(scene, c, size) {
  const r = scene.dimensions.sceneRect;
  return c.x >= r.x && c.y >= r.y && c.x + size <= r.x + r.width && c.y + size <= r.y + r.height;
}

function occupied(scene, c, size) {
  return scene.tokens.some(
    (t) => t.x < c.x + size && t.x + t.width * size > c.x && t.y < c.y + size && t.y + t.height * size > c.y
  );
}

/** true si hay un muro que bloquea el paso entre el token y la casilla (si no se puede calcular, false). */
function wallBetween(t, c, size) {
  try {
    const mid = (x, y, w, h) => ({ x: x + (w * size) / 2, y: y + (h * size) / 2 });
    const a = mid(t.x, t.y, t.width, t.height);
    const b = mid(c.x, c.y, 1, 1);
    return !!CONFIG.Canvas.polygonBackends.move.testCollision(a, b, { type: "move", mode: "any" });
  } catch (_e) {
    return false;
  }
}

/** Sin resultado automatico (sin objetivo o sin CD): pregunta que paso. Devuelve hit|miss|floor|lost|none. */
async function ask(item, targetToken) {
  const buttons = [];
  if (targetToken) {
    buttons.push({ action: "hit", label: `Acerto: pasa a ${targetToken.name}` });
    buttons.push({ action: "miss", label: `Fallo: cae al piso junto a ${targetToken.name}` });
  } else {
    buttons.push({ action: "floor", label: "Cae al piso junto a mi token" });
  }
  buttons.push({ action: "lost", label: "Se pierde" });
  buttons.push({ action: "none", label: "No hacer nada", default: true });
  const why = targetToken ? "No hay resultado automatico del ataque." : "No hay objetivo marcado.";
  return foundry.applications.api.DialogV2.wait({
    window: { title: "PF2E - Throw Weapon" },
    content: `<p>${why} Que paso con <strong>${item.name}</strong>?</p>`,
    buttons,
    rejectClose: false,
  });
}

// ---------------------------------------------------------------------------------------------
// Animaciones (opcionales). Requieren Sequencer; los proyectiles ademas usan las animaciones de JB2A.
// Si una ruta no existe en la instalacion de JB2A del usuario (version gratuita o Patreon), no se anima.
// ---------------------------------------------------------------------------------------------
const PATHS = {
  card: "jb2a.ranged.card.01.projectile",
  dagger: "jb2a.dagger.throw.01.white",
  arrow: "jb2a.arrow.physical.white",
};
const animOn = () => !!setting("animations") && !!game.modules.get("sequencer")?.active && typeof globalThis.Sequence === "function";
const hasPath = (p) => {
  try {
    return !!globalThis.Sequencer?.Database?.entryExists(p);
  } catch (_e) {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Proyectil parecido segun el arma: card | dagger | arrow | null (sin animacion similar: no se anima). */
function projectileKind(item) {
  if (item.flags?.[ID]?.animation === "card") return "card";
  const base = item.system.baseItem;
  const group = item.system.group;
  if (group === "knife" || ["dagger", "kukri", "throwing-knife"].includes(base)) return "dagger";
  if (["dart", "spear"].includes(group) || ["dart", "javelin", "spear", "longspear", "harpoon", "shuriken"].includes(base)) return "arrow";
  return null;
}

const recentAA = []; // efectos recientes de Automated Animations
const pending = new Map(); // id de token objetivo -> instante limite para reemplazar un golpe cuerpo a cuerpo
const markPending = (targetId) => pending.set(targetId, performance.now() + 4000);

function onSequencerEffect(effect) {
  try {
    const file = effect?.data?.file;
    if (typeof file !== "string" || !file.startsWith("autoanimations.")) return;
    const name = String(effect.data?.name ?? "");
    const entry = { t: performance.now(), file, name, replaced: false };
    for (const [id, until] of pending) {
      if (performance.now() < until && file.startsWith("autoanimations.melee.") && name.includes(id)) {
        entry.replaced = true;
        setTimeout(() => {
          try {
            effect.endEffect?.();
          } catch (_e) {
            /* ya terminado */
          }
        }, 0);
      }
    }
    recentAA.push(entry);
    if (recentAA.length > 30) recentAA.shift();
  } catch (_e) {
    /* nunca romper a Sequencer */
  }
}

/** Proyectil del lanzador al objetivo, solo si Automated Animations no animo ya este lanzamiento. */
async function playProjectile({ kind, thrower, targetToken, seenAt }) {
  if (!animOn() || !kind || !thrower?.object || !targetToken?.object) return false;
  const path = PATHS[kind];
  if (!hasPath(path)) return false;
  const aaLive = recentAA.some((e) => e.t >= seenAt - 50 && e.name.includes(targetToken.id) && !e.replaced);
  if (aaLive) return false;
  try {
    await Promise.race([
      new Sequence().effect().file(path).atLocation(thrower.object).stretchTo(targetToken.object).waitUntilFinished().play(),
      sleep(4000),
    ]);
    return true;
  } catch (e) {
    console.warn(`${ID} | la animacion del proyectil fallo`, e);
    return false;
  }
}

/** El icono del arma vuela (girando) desde el token hasta la casilla donde queda en el piso. */
async function playLanding(item, fromTok, cell) {
  if (!item || !animOn() || !fromTok?.parent) return;
  const size = fromTok.parent.grid.size;
  const center = (x, y, w, h) => ({ x: x + (w * size) / 2, y: y + (h * size) / 2 });
  const from = center(fromTok.x, fromTok.y, fromTok.width, fromTok.height);
  const to = center(cell.x, cell.y, 1, 1);
  try {
    await Promise.race([
      new Sequence()
        .effect()
        .file(item.img)
        .atLocation(from)
        .moveTowards(to, { ease: "easeOutQuad" })
        .duration(600)
        .size(0.5, { gridUnits: true })
        .animateProperty("sprite", "rotation", { from: 0, to: 360, duration: 600 })
        .fadeOut(150)
        .waitUntilFinished()
        .play(),
      sleep(3000),
    ]);
  } catch (e) {
    console.warn(`${ID} | la animacion de caida fallo`, e);
  }
}

/** Aviso del resultado segun el ajuste: toast (lanzador + GMs), tarjeta solo GM, tarjeta publica o nada. */
function notify(actor, item, text) {
  const mode = setting("notify");
  if (mode === "off") return;
  if (mode === "toast") {
    const line = `${actor.name}: ${item.name} ${text}.`;
    ui.notifications.info(line);
    game.socket.emit(`module.${ID}`, { text: line });
    return;
  }
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>Throw Weapon</strong>: ${item.name} ${text}.</p>`,
    ...(mode === "gm" ? { whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id) } : {}),
  });
}
