const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { ethers } = require('ethers');

// Use the same demo private key as sign_frames.js
const PRIVATE_KEY = '0x59c6995e998f97a5a0044976f83be7f7e7a5f0e7b39dbe7e5c5b8d6e7a5c7d6b';
const INPUT_VIDEO = path.resolve(__dirname, 'test.mp4');
const OUTPUT_DIR = path.resolve(__dirname, 'output');

const ensureDir = async (dirPath) => fsp.mkdir(dirPath, { recursive: true });
const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

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
            for (const line of lines) {
                const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
                if (!m) continue;
                const key = m[1].toLowerCase();
                const val = m[2];
                if (key === 'artist') artist = val;
                if (key === 'album') album = val;
            }
            resolve({ artist, album });
        });
    });
};

const writeMetadata = async (inputPath, outputPath, { artist, album, title, comment }) => {
    // Preserve original metadata (map_metadata 0), only override provided keys
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-map_metadata', '0'];
    if (typeof artist === 'string') args.push('-metadata', `artist=${artist}`);
    if (typeof album === 'string') args.push('-metadata', `album=${album}`);
    if (typeof title === 'string') args.push('-metadata', `title=${title}`);
    if (typeof comment === 'string') args.push('-metadata', `comment=${comment}`);
    args.push('-movflags', 'use_metadata_tags', '-c', 'copy', outputPath);
    await new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg (write metadata) exited ${code}`))));
    });
};

// Canonical writer: strip all metadata first, then only set provided keys
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

const c = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const bold = c(1), green = c(32), red = c(31), dim = c(2), cyan = c(36), magenta = c(35);
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

const main = async () => {
    try {
        if (!fs.existsSync(INPUT_VIDEO)) {
            console.error(`Input video not found: ${INPUT_VIDEO}`);
            process.exitCode = 1;
            return;
        }

        const wallet = new ethers.Wallet(PRIVATE_KEY);
        const startTimestampMs = Date.now();
        const signerAddress = wallet.address;

        console.log(cyan('='.repeat(60)));
        console.log(`${bold('Whole-File Signer')} ${dim('(EIP-191, keccak256, secp256k1)')}`);
        console.log(`${dim('Video:')} ${path.basename(INPUT_VIDEO)}  ${dim('Signer:')} ${signerAddress}`);
        console.log(`${dim('Start:')} ${new Date(startTimestampMs).toISOString()}`);
        console.log(cyan('='.repeat(60)));

        const step = stepRunner(5);
        await ensureDir(OUTPUT_DIR);

        const verifiableDir = path.join(__dirname, 'verifiable mp4s');
        await ensureDir(verifiableDir);
        const baseName = path.basename(INPUT_VIDEO);
        const tempPath1 = path.join(verifiableDir, baseName.replace(/\.mp4$/i, '.tmp.mp4'));
        const tempPath2 = path.join(verifiableDir, baseName.replace(/\.mp4$/i, '.tmp2.mp4'));
        const finalPath = path.join(verifiableDir, baseName);

        await step('Make temporary copy in verifiable folder', async () => {
            await fsp.copyFile(INPUT_VIDEO, tempPath1);
            console.log(`${dim('Temp copy:')} ${tempPath1}`);
        });

        await step('Create canonical copy: only comment=timestamp (strip other tags)', async () => {
            await writeCanonicalMetadata(tempPath1, tempPath2, { comment: String(startTimestampMs) });
            console.log(`${dim('Canonical comment (ts):')} ${startTimestampMs}`);
        });

        const { fileHashHex, signature, r, s, v } = await step('Hash and sign canonical MP4', async () => {
            const fileBuf = await fsp.readFile(tempPath2);
            const fileHashHexLocal = sha256Hex(fileBuf);
            const messageString = JSON.stringify({ timestampMs: startTimestampMs, fileHashSha256: fileHashHexLocal });
            const sig = await wallet.signMessage(messageString);
            const parts = ethers.utils.splitSignature(sig);
            console.log(`${dim('SHA-256:')} ${fileHashHexLocal}`);
            console.log(`${dim('Message:')} ${messageString}`);
            console.log(`${dim('Signature:')} ${sig}`);
            return { fileHashHex: fileHashHexLocal, signature: sig, r: parts.r, s: parts.s, v: parts.v };
        });

        await step('Write video_hash.txt', async () => {
            const outTxt = path.join(OUTPUT_DIR, 'video_hash.txt');
            const lines = [
                path.basename(INPUT_VIDEO),
                String(startTimestampMs),
                fileHashHex
            ].join('\n') + '\n';
            await fsp.writeFile(outTxt, lines, 'utf8');
            console.log(`${dim('Wrote:')} ${outTxt}`);
        });

        await step('Populate comment with JSON (timestamp,filehash,signerAddress,signature) on original and finalize', async () => {
            const payload = JSON.stringify({ timestampMs: startTimestampMs, fileHashSha256: fileHashHex, signerAddress, signature });
            await fsp.rm(tempPath2, { force: true });
            await writeMetadata(tempPath1, tempPath2, { comment: payload });
            await fsp.rm(tempPath1, { force: true });
            // Write final output name
            await fsp.rm(finalPath, { force: true });
            await fsp.rename(tempPath2, finalPath);
            console.log(`${dim('Wrote verifiable MP4:')} ${finalPath}`);
        });

        console.log(cyan('='.repeat(60)));
        console.log(`${green('DONE')} ${dim(path.basename(INPUT_VIDEO))}`);
        console.log(cyan('='.repeat(60)));

        // Note: Changing metadata alters file bytes and therefore its hash.
        // We compute the hash after embedding only the timestamp in the comment field (preserving all other tags),
        // then store full verification data as JSON in the comment field.
    } catch (err) {
        console.error(err.stack || err.message || String(err));
        process.exitCode = 1;
    }
};

main();


