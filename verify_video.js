const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { ethers } = require('ethers');

const VERIFIABLE_DIR = path.join(__dirname, 'verifiable mp4s');
const OUTPUT_DIR = path.join(__dirname, 'output');

const ensureDir = async (dirPath) => fsp.mkdir(dirPath, { recursive: true });
const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const c = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const bold = c(1), green = c(32), red = c(31), dim = c(2), cyan = c(36), magenta = c(35), yellow = c(33);
const nowMs = () => Date.now();
const fmtDur = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);

const stepRunner = (total) => {
    let cur = 0;
    const run = async (title, fn) => {
        cur += 1;
        const p = `${magenta(`STEP ${cur}/${total}`)}`;
        console.log(`${p} ${bold(title)}`);
        const t0 = nowMs();
        try {
            const r = await fn();
            console.log(`${green('PASS')} ${dim(`(${fmtDur(nowMs() - t0)})`)}`);
            return r;
        } catch (e) {
            console.error(`${red('FAIL')} ${dim(`(${fmtDur(nowMs() - t0)})`)} - ${e.message || String(e)}`);
            throw e;
        }
    };
    return run;
};

const readMetadataTags = async (filePath) => {
    return new Promise((resolve, reject) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-f', 'ffmetadata', '-'];
        const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', () => { });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code !== 0) return reject(new Error(`ffmpeg (read metadata) exited ${code}`));
            const lines = out.split(/\r?\n/);
            let artist = '';
            let album = '';
            let comment = '';
            for (const line of lines) {
                const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
                if (!m) continue;
                const key = m[1].toLowerCase();
                const val = m[2];
                if (key === 'artist') artist = val;
                if (key === 'album') album = val;
                if (key === 'comment') comment = val;
            }
            resolve({ artist, album, comment });
        });
    });
};

// Canonical writer used during verification: strip all metadata before setting specific tags
const writeCanonicalMetadata = async (inputPath, outputPath, { artist, album, title, comment }) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-map_metadata', '-1'];
    if (typeof artist === 'string') args.push('-metadata', `artist=${artist}`);
    if (typeof album === 'string') args.push('-metadata', `album=${album}`);
    if (typeof title === 'string') args.push('-metadata', `title=${title}`);
    if (typeof comment === 'string') args.push('-metadata', `comment=${comment}`);
    args.push('-movflags', 'use_metadata_tags', '-c', 'copy', outputPath);
    await new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (write canonical metadata) exited ${code}`))));
    });
};

const main = async () => {
    try {
        await ensureDir(VERIFIABLE_DIR);
        await ensureDir(OUTPUT_DIR);

        const target = process.argv[2] ? path.join(VERIFIABLE_DIR, process.argv[2]) : null;
        const expectedTs = process.argv[3] ? String(process.argv[3]) : null;
        if (!target || !fs.existsSync(target)) {
            const files = (await fsp.readdir(VERIFIABLE_DIR)).filter((f) => f.toLowerCase().endsWith('.mp4'));
            if (files.length === 0) {
                console.error('No MP4s found in verifiable mp4s');
                process.exitCode = 1;
                return;
            }
            console.log(`${yellow('No file specified; using first found:')} ${files[0]}`);
            return await mainWith(path.join(VERIFIABLE_DIR, files[0]), expectedTs);
        }
        return await mainWith(target, expectedTs);
    } catch (err) {
        console.error(err.stack || err.message || String(err));
        process.exitCode = 1;
    }
};

const mainWith = async (filePath, expectedTs) => {
    const totalSteps = 5;
    const step = stepRunner(totalSteps);
    const base = path.basename(filePath);

    console.log(cyan('='.repeat(60)));
    console.log(`${bold('Verifiable Video Validator')}`);
    console.log(`${dim('Input:')} ${base}`);
    if (expectedTs) console.log(`${dim('Expected timestamp:')} ${expectedTs}`);
    console.log(cyan('='.repeat(60)));

    const temp1 = filePath.replace(/\.mp4$/i, '.tmp.mp4');
    const temp2 = filePath.replace(/\.mp4$/i, '.tmp2.mp4');

    await step('Make temporary working copy', async () => {
        await fsp.copyFile(filePath, temp1);
        console.log(`${dim('Temp:')} ${temp1}`);
    });

    const { payloadJson, tsFromComment } = await step('Read comment JSON metadata', async () => {
        const tags = await readMetadataTags(temp1);
        const payload = (tags.comment || '').trim();
        if (!payload) throw new Error('Missing comment JSON payload');
        let parsed;
        try { parsed = JSON.parse(payload); } catch (_) { throw new Error('Invalid comment JSON payload'); }
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid comment JSON payload');
        return { payloadJson: parsed, tsFromComment: String(parsed.timestampMs) };
    });

    const tsStr = String(payloadJson.timestampMs);
    const fileHashExpected = String(payloadJson.fileHashSha256);
    const signerAddress = String(payloadJson.signerAddress);
    const signature = String(payloadJson.signature);

    await step('Recompute file hash (timestamp in comment) and compare', async () => {
        // Hash the canonical form: only comment=timestamp present
        await writeCanonicalMetadata(temp1, temp2, { comment: tsStr });
        await fsp.rm(temp1, { force: true });
        await fsp.rename(temp2, temp1);
        const buf = await fsp.readFile(temp1);
        const actualHash = sha256Hex(buf);
        console.log(`${dim('Expected hash:')} ${fileHashExpected}`);
        console.log(`${dim('Actual   hash:')} ${actualHash}`);
        if (actualHash.toLowerCase() !== fileHashExpected.toLowerCase()) {
            throw new Error('Hash mismatch - file was modified');
        }
    });

    await step('Check timestamp is numeric', async () => {
        if (!/^\d{10,}$/.test(tsStr)) throw new Error('Malformed timestamp');
    });


    await step('Validate signer address is shaped properly', async () => {
        if (!/^0x[a-fA-F0-9]{40}$/.test(signerAddress)) {
            throw new Error('Malformed signer address');
        }
    });

    await step('Verify signature over {timestampMs,fileHashSha256}', async () => {
        const msg = JSON.stringify({ timestampMs: Number(tsStr), fileHashSha256: fileHashExpected });
        const recovered = ethers.utils.verifyMessage(msg, signature);
        if (recovered.toLowerCase() !== signerAddress.toLowerCase()) {
            throw new Error('Signature does not match signer address');
        }
    });

    console.log(green('PASS'));
    console.log(`${bold('Verified:')} hash matches canonical(comment=timestamp), timestamp validated, signature covers {timestampMs,fileHashSha256}.`);
    console.log(`${dim('Signer:')} ${signerAddress}`);
    console.log(`${dim('Timestamp:')} ${tsStr}`);

    await fsp.rm(temp1, { force: true });
};

main();
