import { crc32 } from "../util/crc32";
import { dHash, hashToHex, hexToHash, hammingDistance, isSimilar } from "../util/phash";
import { AtlasSnapshotFragment } from "./reflect2d";

// API endpoint for items
const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:42069";
const ITEMS_API = `${API_BASE}/api/items`;

// API item type
interface ApiItem {
    id: number;
    pHash: string;
    name: string;
    firstSeen: string;
    createdAt: string;
    updatedAt: string;
}

// sprite hash files generated using runeapps model viewer https://runeapps.org/modelviewer
// scripts->cli->run
// alternatively use cli version and prepend `node dist/cli.js -o openrs2last`

// extract -m spritehash --batchsize=1000000
const spritehashes = require("!!file-loader?name=data/[name].[ext]!./data/spritehash.batch.json");
// extract -m fonthash --batchsize=1000000
const fontfile = require("!!file-loader?name=data/[name].[ext]!./data/fonthash.batch.json");
// created manually using the tools in UI State
const chat10ptfile = require("!!file-loader?name=data/[name].[ext]!./data/chat10pt.json");
const chat12ptfile = require("!!file-loader?name=data/[name].[ext]!./data/chat12pt.json");
const chat14ptfile = require("!!file-loader?name=data/[name].[ext]!./data/chat14pt.json");
const chat16ptfile = require("!!file-loader?name=data/[name].[ext]!./data/chat16pt.json");
const chat18ptfile = require("!!file-loader?name=data/[name].[ext]!./data/chat18pt.json");
const chat20ptfile = require("!!file-loader?name=data/[name].[ext]!./data/chat20pt.json");
const chat22ptfile = require("!!file-loader?name=data/[name].[ext]!./data/chat22pt.json");
const s8x11ptfile = require("!!file-loader?name=data/[name].[ext]!./data/8x11Chars.json");
const s11x12ptfile = require("!!file-loader?name=data/[name].[ext]!./data/11x12Chars.json");
const s7x9ptfile = require("!!file-loader?name=data/[name].[ext]!./data/7x9Chars.json");
export type FontCharacterJson = {
    chr: string,
    charcode: number,
    x: number,
    y: number,
    width: number,
    height: number,
    bearingy: number,
    hash: number
}

export type ParsedFontJson = {
    fontid: number,
    spriteid: number,
    characters: (FontCharacterJson | null)[],
    median: number,
    baseline: number,
    maxascent: number,
    maxdescent: number,
    scale: number,
    sheethash: number,
    sheetwidth: number,
    sheetheight: number,
    sheet: string
}

type CustomJsonFont = {
    sheetwidth: number,
    sheetheight: number,
    sheethash: number,
    spriteid: number,
    characters: FontCharacterJson[],
    unknownchars: UknownFontChar[]
}

type SpriteCacheJson = {
    id: number,
    sub: number,
    hash: number
};

export type FontSpriteChar = FontCharacterJson;

export class SpriteInfo {
    id: number;
    subid: number;
    hash: number;
    pHash: string | null = null;      // Perceptual hash (stable across sessions)
    fontchr: FontSpriteChar | null = null;
    font: KnownSpriteSheet | null = null;
    itemName: string | null = null;   // Item name from Item-Hashes.json
    synonym: SpriteInfo;//circular linked list of synonyms
    constructor(id: number, subid: number, hash: number) {
        this.id = id;
        this.subid = subid;
        this.hash = hash;
        this.synonym = this;
    }
}

export function imgcrc(img: ImageData) {
    let data = img.data.slice();
    // for some reason *some times* 0 blue gets turned into 1 blue
    // always set it to 1 for hash computation
    for (let i = 0; i < data.length; i += 4) { if (data[i + 2] == 0) { data[i + 2] = 1; } }
    return crc32(data);
}

type UknownFontChar = {
    x: number,
    y: number,
    charcode: number
}

export class KnownSpriteSheet {
    spriteid: number;
    subs = new Set<SpriteInfo>();
    unknownsubs: UknownFontChar[] = [];
    fontfile: ParsedFontJson | null = null;

    basesprite: SpriteInfo;
    sheetwidth: number;
    sheetheight: number;
    constructor(spriteid: number, width: number, height: number, sheethash: number) {
        this.spriteid = spriteid
        this.basesprite = new SpriteInfo(spriteid, 0, sheethash);
        this.basesprite.font = this;
        this.sheetwidth = width;
        this.sheetheight = height;
    }

    addFontFile(fontfile: ParsedFontJson) {
        this.fontfile = fontfile;
        for (let chr of fontfile.characters) {
            if (!chr) { continue; }
            let sub = new SpriteInfo(fontfile.spriteid, chr.charcode, chr.hash);
            this.subs.add(sub);
            sub.font = this;
            sub.fontchr = chr;
        }
    }

    addUknownSub(dx: number, dy: number, charcode: number) {
        this.unknownsubs.push({ x: dx, y: dy, charcode: charcode });
    }

    addCharSprite(charcode: number, dx: number, dy: number, width: number, height: number, hash: number) {
        let known = new SpriteInfo(this.spriteid, charcode, hash);
        known.font = this;
        known.fontchr = {
            chr: String.fromCharCode(charcode),
            charcode: charcode,
            x: dx,
            y: dy,
            width: width,
            height: height,
            hash: known.hash,
            bearingy: 0,//unknown
        };
        this.subs.add(known);
        return known;
    }

    identifyMissingCharacter(charcode: number, dx: number, dy: number, width: number, height: number, hash: number) {
        let known = this.addCharSprite(charcode, dx, dy, width, height, hash);
        this.unknownsubs = this.unknownsubs.filter(c => c.charcode != charcode);
        console.log(`font char "${String.fromCharCode(charcode)}" matched by containment in font ${this.spriteid}`);
        return known;
    }

    resizeSheetBox() {
        if (this.unknownsubs.length == 0 && this.subs.size == 0) {
            throw new Error("no subs to size from");
        }
        let minx = Math.min.apply(null, [...this.subs.values().map(q => q.fontchr!.x), ...this.unknownsubs.map(q => q.x)]);
        let miny = Math.min.apply(null, [...this.subs.values().map(q => q.fontchr!.y), ...this.unknownsubs.map(q => q.y)]);
        let maxx = Math.max.apply(null, [...this.subs.values().map(q => q.fontchr!.x + q.fontchr!.width), ...this.unknownsubs.map(q => q.x + 1)]);
        let maxy = Math.max.apply(null, [...this.subs.values().map(q => q.fontchr!.y + q.fontchr!.height), ...this.unknownsubs.map(q => q.y + 1)]);

        this.sheetwidth = maxx - minx;
        this.sheetheight = maxy - miny;
        this.basesprite.hash = 0;

        for (let sub of this.subs) {
            sub.fontchr!.x -= minx;
            sub.fontchr!.y -= miny;
        }
        for (let chr of this.unknownsubs) {
            chr.x -= minx;
            chr.y -= miny;
        }

        return { dx: minx, dy: miny };
    }

    toJSON() {
        let res: CustomJsonFont = {
            sheetwidth: this.sheetwidth,
            sheetheight: this.sheetheight,
            sheethash: this.basesprite.hash,
            spriteid: this.spriteid,
            characters: [...this.subs].map(s => s.fontchr).filter(c => c != null),
            unknownchars: [...this.unknownsubs],
        };
        return res;
    }
}

const whitePixelImage = new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
export const emptySpriteInfo = new SpriteInfo(-1, 0, imgcrc(whitePixelImage));

export class SpriteCache {
    hashes = new Map<number, SpriteInfo>();
    fonts = new Map<number, KnownSpriteSheet>();
    pHashItems = new Map<string, string>(); // pHash hex -> item name
    readyResolvers = Promise.withResolvers<void>();
    ready = this.readyResolvers.promise;

    constructor() {
        this.hashes.set(emptySpriteInfo.hash, emptySpriteInfo);
    }

    /**
     * Load item hashes from API
     * Uses pHash (perceptual hash) for cross-session stable item identification
     */
    async loadItemHashes(): Promise<void> {
        // Skip API fetch in Electron — localhost:42069 dev server isn't running,
        // and the failed fetch spams Chromium net::ERR_CONNECTION_REFUSED in console.
        if (typeof navigator !== "undefined" && navigator.userAgent.includes("Electron")) {
            return;
        }
        try {
            const response = await fetch(`${ITEMS_API}?limit=500`);
            if (!response.ok) {
                return;
            }
            const result = await response.json() as { items: ApiItem[]; total: number };
            const items = result.items || [];
            for (const item of items) {
                if (!item.name || !item.pHash) continue;
                this.pHashItems.set(item.pHash, item.name);
            }
        } catch {
            // Silently ignore — API server (localhost:42069) not running in Electron/production
        }
    }

    /**
     * Get item name by perceptual hash (exact match)
     * @param pHashHex - 16-character hex string of the perceptual hash
     * @returns Item name or null if not found
     */
    getItemByPHash(pHashHex: string): string | null {
        return this.pHashItems.get(pHashHex) ?? null;
    }

    /**
     * Find item by perceptual hash with fuzzy matching
     * Uses Hamming distance to find visually similar items
     * @param pHashHex - 16-character hex string of the perceptual hash
     * @param threshold - Maximum Hamming distance (default: 10, lower = stricter)
     * @returns Best match or null
     */
    findItemByPHash(pHashHex: string, threshold: number = 10): { name: string; distance: number; pHash: string } | null {
        // First try exact match
        const exactName = this.pHashItems.get(pHashHex);
        if (exactName) {
            return { name: exactName, distance: 0, pHash: pHashHex };
        }

        // Fuzzy match using Hamming distance
        const targetHash = hexToHash(pHashHex);
        let bestMatch: { name: string; distance: number; pHash: string } | null = null;

        for (const [storedPHash, name] of this.pHashItems) {
            const storedHash = hexToHash(storedPHash);
            const distance = hammingDistance(targetHash, storedHash);

            if (distance <= threshold) {
                if (!bestMatch || distance < bestMatch.distance) {
                    bestMatch = { name, distance, pHash: storedPHash };
                }
            }
        }

        return bestMatch;
    }

    /**
     * Check if an item exists by pHash
     */
    hasItemByPHash(pHashHex: string): boolean {
        return this.pHashItems.has(pHashHex);
    }

    /**
     * Reverse lookup: get pHash by item name (case-insensitive)
     * Returns the first matching pHash or null
     */
    getItemPHashByName(name: string): string | null {
        const lowerName = name.toLowerCase();
        for (const [pHash, itemName] of this.pHashItems) {
            if (itemName.toLowerCase() === lowerName) {
                return pHash;
            }
        }
        return null;
    }

    /**
     * Get all known items (for debugging/display)
     */
    getAllItems(): Array<{ pHash: string; name: string }> {
        return Array.from(this.pHashItems.entries()).map(([pHash, name]) => ({
            pHash,
            name,
        }));
    }

    addSprite(info: SpriteInfo) {
        let prev = this.hashes.get(info.hash);
        if (prev) {
            info.synonym = prev.synonym
            prev.synonym = info;
        } else {
            this.hashes.set(info.hash, info);
        }
        return info;
    }

    loadSpriteList(list: SpriteCacheJson[]) {
        list.forEach(spr => this.addSprite(new SpriteInfo(spr.id, spr.sub, spr.hash)));
    }

    loadCacheFontFile(fonts: ParsedFontJson[]) {
        for (let fontjson of fonts) {
            let font = new KnownSpriteSheet(fontjson.spriteid, fontjson.sheetwidth, fontjson.sheetheight, fontjson.sheethash);
            font.addFontFile(fontjson);
            this.fonts.set(font.spriteid, font);
            font.subs.forEach(sub => this.addSprite(sub));
        }
    }
    loadCustomFontFile(fontjson: CustomJsonFont) {
        let font = new KnownSpriteSheet(fontjson.spriteid, fontjson.sheetwidth, fontjson.sheetheight, fontjson.sheethash);
        for (let chr of fontjson.characters) {
            font.addCharSprite(chr.charcode, chr.x, chr.y, chr.width, chr.height, chr.hash);
        }
        for (let unk of fontjson.unknownchars) {
            font.addUknownSub(unk.x, unk.y, unk.charcode);
        }
        // TODO need unique id
        this.fonts.set(font.spriteid, font);
        font.subs.forEach(sub => this.addSprite(sub));
    }

    async downloadCacheData() {
        let spritedata: SpriteCacheJson[] = await fetch(spritehashes.default).then(res => res.json());
        this.loadSpriteList(spritedata);

        let fontdata: ParsedFontJson[] = await fetch(fontfile.default).then(res => res.json());
        this.loadCacheFontFile(fontdata);

        // Load all chat font sizes (10pt - 22pt)
        const chat10ptdata: CustomJsonFont = await fetch(chat10ptfile.default).then(res => res.json());
        this.loadCustomFontFile(chat10ptdata);
        const chat12ptdata: CustomJsonFont = await fetch(chat12ptfile.default).then(res => res.json());
        this.loadCustomFontFile(chat12ptdata);
        const chat14ptdata: CustomJsonFont = await fetch(chat14ptfile.default).then(res => res.json());
        this.loadCustomFontFile(chat14ptdata);
        const chat16ptdata: CustomJsonFont = await fetch(chat16ptfile.default).then(res => res.json());
        this.loadCustomFontFile(chat16ptdata);
        const chat18ptdata: CustomJsonFont = await fetch(chat18ptfile.default).then(res => res.json());
        this.loadCustomFontFile(chat18ptdata);
        const chat20ptdata: CustomJsonFont = await fetch(chat20ptfile.default).then(res => res.json());
        this.loadCustomFontFile(chat20ptdata);
        const chat22ptdata: CustomJsonFont = await fetch(chat22ptfile.default).then(res => res.json());
        this.loadCustomFontFile(chat22ptdata);

        // Load other font formats
        const s8x11ptdata: CustomJsonFont = await fetch(s8x11ptfile.default).then(res => res.json());
        this.loadCustomFontFile(s8x11ptdata);
        const s11x12ptdata: CustomJsonFont = await fetch(s11x12ptfile.default).then(res => res.json());
        this.loadCustomFontFile(s11x12ptdata);
        const s7x9ptdata: CustomJsonFont = await fetch(s7x9ptfile.default).then(res => res.json());
        this.loadCustomFontFile(s7x9ptdata);

        // Load discovered item hashes from API
        await this.loadItemHashes();
    }
}


function imageMemCompare(a: ImageData, b: ImageData) {
    if (a.width != b.width || a.height != b.height) { return false; }
    // let simpletrue = simpleCompare(b, a, 0, 0, 5) < Infinity;
    // return simpletrue;
    let memtrue = true;
    for (let i = 0; i < a.data.length; i += 4) {
        if (a.data[i + 3] != b.data[i + 3]) { memtrue = false; break; }
        if (a.data[i + 3] == 0) { continue; }
        if (a.data[i + 0] != b.data[i + 0]) { memtrue = false; break; }
        if (a.data[i + 1] != b.data[i + 1]) { memtrue = false; break; }
        if (a.data[i + 2] != b.data[i + 2]) { memtrue = false; break; }
    }
    // // if (simpletrue != memtrue) {
    // // 	debugger;
    // // }

    return memtrue;
}