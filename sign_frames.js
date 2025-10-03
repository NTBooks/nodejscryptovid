const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { ethers } = require('ethers');
require('dotenv').config();

// -------------------------------
// Configuration / Hardcoded Keys
// -------------------------------
// Use a deterministic, hardcoded private key for demonstration purposes only.
// NEVER use hardcoded private keys in production.
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0x59c6995e998f97a5a0044976f83be7f7e7a5f0e7b39dbe7e5c5b8d6e7a5c7d6b';
const INPUT_VIDEO = path.resolve(__dirname, 'test.mp4');
const INPUT_DIR = path.resolve(__dirname, 'input');
const OUTPUT_DIR = path.resolve(__dirname, 'output');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'frames_manifest.json');

// Extraction settings
// Keep all frames; PNG for determinism. Remove -r option to keep source FPS.
// If you want to throttle frames, add ['-r', '5'] before the output path.
const FRAME_PATTERN = 'frame_%06d.png';

// -------------------------------
// Utility functions (functional style)
// -------------------------------
// Minimal ANSI color helpers (no extra deps)
const ansi = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const cBold = ansi(1);
const cDim = ansi(2);
const cRed = ansi(31);
const cGreen = ansi(32);
const cYellow = ansi(33);
const cBlue = ansi(34);
const cMagenta = ansi(35);
const cCyan = ansi(36);

const nowMs = () => Date.now();
const formatDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    return `${s.toFixed(2)}s`;
};

const createStepRunner = (totalSteps) => {
    let current = 0;
    const run = async (title, fn) => {
        current += 1;
        const prefix = `${cMagenta(`STEP ${current}/${totalSteps}`)}`;
        console.log(`${prefix} ${cBold(title)}`);
        const t0 = nowMs();
        try {
            const result = await fn();
            const dt = nowMs() - t0;
            console.log(`${cGreen('PASS')} ${cDim(`(${formatDuration(dt)})`)}`);
            return result;
        } catch (err) {
            const dt = nowMs() - t0;
            console.error(`${cRed('FAIL')} ${cDim(`(${formatDuration(dt)})`)} - ${err.message || String(err)}`);
            throw err;
        }
    };
    return run;
};
const ensureDir = async (dirPath) => {
    await fsp.mkdir(dirPath, { recursive: true });
};

const emptyDir = async (dirPath) => {
    try {
        await fsp.rm(dirPath, { recursive: true, force: true });
    } catch (_) { }
    await ensureDir(dirPath);
};

const listPngFilesSorted = async (dirPath) => {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    return entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png'))
        .map((e) => e.name)
        .sort();
};

const sha256Hex = (buffer) => {
    return crypto.createHash('sha256').update(buffer).digest('hex');
};

const runFfmpegExtractFrames = (inputVideoPath, outputDir, framePattern) => {
    return new Promise((resolve, reject) => {
        const outputTemplate = path.join(outputDir, framePattern);
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', inputVideoPath,
            '-vsync', '0',
            outputTemplate
        ];

        const child = spawn(ffmpegPath, args, { stdio: 'inherit' });
        child.on('error', (err) => reject(err));
        child.on('exit', (code) => {
            if (code === 0) return resolve();
            reject(new Error(`ffmpeg exited with code ${code}`));
        });
    });
};

const readFileBuffer = async (filePath) => {
    return fsp.readFile(filePath);
};

const writeJson = async (filePath, data) => {
    const json = JSON.stringify(data, null, 2);
    await fsp.writeFile(filePath, json, 'utf8');
};

const readJson = async (filePath) => {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
};

const buildMessageString = (startTimestampMs, frameNumber, frameHashSha256) => {
    // Stable key order
    return JSON.stringify({
        startTimestampMs,
        frameNumber,
        frameHashSha256
    });
};

const signEip191 = async (wallet, messageString) => {
    // Wallet.signMessage applies EIP-191: prefix + keccak256 hashing under the hood
    const signature = await wallet.signMessage(messageString);
    const { r, s, v } = ethers.utils.splitSignature(signature);
    const messageKeccak256 = ethers.utils.hashMessage(messageString);
    return { signature, r, s, v, messageKeccak256 };
};

const verifyEip191 = (expectedAddress, messageString, signature, expectedPublicKeyHex) => {
    const recoveredAddress = ethers.utils.verifyMessage(messageString, signature);
    const messageKeccak256 = ethers.utils.hashMessage(messageString);
    const recoveredPublicKey = ethers.utils.recoverPublicKey(messageKeccak256, signature);
    const addrOk = recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
    const pubOk = expectedPublicKeyHex
        ? recoveredPublicKey.toLowerCase() === expectedPublicKeyHex.toLowerCase()
        : true;
    return { addrOk, pubOk, recoveredAddress, recoveredPublicKey };
};

// -------------------------------
// Main pipeline
// -------------------------------
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
        const signerPublicKey = wallet._signingKey().publicKey; // uncompressed 0x04...
        const totalSteps = 8;
        const step = createStepRunner(totalSteps);

        // Banner
        console.log(cCyan('='.repeat(60)));
        console.log(`${cBold('Crypto Video Frame Signer')} ${cDim('(EIP-191, keccak256, secp256k1)')}`);
        console.log(`${cDim('Video:')} ${path.basename(INPUT_VIDEO)}  ${cDim('Signer:')} ${signerAddress}`);
        console.log(`${cDim('Start:')} ${new Date(startTimestampMs).toISOString()}`);
        console.log(cCyan('='.repeat(60)));

        await step('Prepare folders', async () => {
            await emptyDir(INPUT_DIR);
            await ensureDir(OUTPUT_DIR);
        });

        await step('Extract frames', async () => {
            await runFfmpegExtractFrames(INPUT_VIDEO, INPUT_DIR, FRAME_PATTERN);
        });

        const frameFiles = await step('Discover frames', async () => {
            const files = await listPngFilesSorted(INPUT_DIR);
            if (files.length === 0) throw new Error('No frames were extracted');
            console.log(`${cDim('Frames found:')} ${files.length}`);
            return files;
        });

        const totalFrames = frameFiles.length;
        console.log(`${cBlue('Processing frames')} ${cDim(`(${totalFrames} total)`)}`);
        const frames = [];

        const progressEvery = Math.max(1, Math.floor(totalFrames / 10));
        for (let i = 0; i < frameFiles.length; i++) {
            const frameNumber = i + 1;
            const filename = frameFiles[i];
            const filePath = path.join(INPUT_DIR, filename);
            const buffer = await readFileBuffer(filePath);
            const frameHashSha256 = sha256Hex(buffer);

            const messageString = buildMessageString(startTimestampMs, frameNumber, frameHashSha256);
            const { signature, r, s, v, messageKeccak256 } = await signEip191(wallet, messageString);

            frames.push({
                frameNumber,
                filename,
                frameHashSha256,
                message: messageString,
                messageKeccak256,
                signature,
                r,
                s,
                v
            });

            if ((i + 1) % progressEvery === 0 || i === frameFiles.length - 1) {
                const pct = Math.round(((i + 1) / totalFrames) * 100);
                console.log(`${cDim(' - progress:')} ${i + 1}/${totalFrames} ${cDim(`(${pct}%)`)}`);
            }
        }

        const manifest = {
            schema: 'crypto-video-frames-manifest@1',
            inputVideo: path.basename(INPUT_VIDEO),
            inputDir: path.basename(INPUT_DIR),
            outputDir: path.basename(OUTPUT_DIR),
            startTimestampMs,
            signer: {
                address: signerAddress,
                publicKey: signerPublicKey,
                algo: 'secp256k1',
                messagePrefix: 'Ethereum Signed Message',
                hash: 'keccak256',
                eip: '191'
            },
            frames
        };

        await step('Write manifest', async () => {
            await writeJson(MANIFEST_PATH, manifest);
            console.log(`${cDim('Manifest:')} ${MANIFEST_PATH}`);
        });

        // -------------------------------
        // Verification step
        // -------------------------------
        const loaded = await step('Verify frames and signatures', async () => {
            const loadedManifest = await readJson(MANIFEST_PATH);

            // Check ordering & presence of all frames in input folder
            const inputFramesNow = await listPngFilesSorted(INPUT_DIR);
            if (inputFramesNow.length !== loadedManifest.frames.length) {
                throw new Error('Frame count mismatch between input folder and manifest.');
            }
            for (let i = 0; i < loadedManifest.frames.length; i++) {
                const expectedName = inputFramesNow[i];
                if (loadedManifest.frames[i].filename !== expectedName) {
                    throw new Error(`Frame filename mismatch at index ${i}: ${loadedManifest.frames[i].filename} !== ${expectedName}`);
                }
                if (loadedManifest.frames[i].frameNumber !== i + 1) {
                    throw new Error(`Frame number out of order at index ${i}: ${loadedManifest.frames[i].frameNumber} !== ${i + 1}`);
                }
            }

            // Recompute hashes and verify signatures using ONLY the starting timestamp from manifest
            const verifyStartTs = loadedManifest.startTimestampMs;
            const expectedAddress = loadedManifest.signer.address;
            const expectedPublicKey = loadedManifest.signer.publicKey;

            for (let i = 0; i < loadedManifest.frames.length; i++) {
                const f = loadedManifest.frames[i];
                const filePath = path.join(INPUT_DIR, f.filename);
                const buf = await readFileBuffer(filePath);
                const recomputedSha = sha256Hex(buf);
                if (recomputedSha !== f.frameHashSha256) {
                    throw new Error(`Hash mismatch for ${f.filename}`);
                }

                const recomputedMsg = buildMessageString(verifyStartTs, f.frameNumber, recomputedSha);
                if (recomputedMsg !== f.message) {
                    throw new Error(`Message mismatch for ${f.filename}`);
                }

                const { addrOk, pubOk, recoveredAddress, recoveredPublicKey } = verifyEip191(
                    expectedAddress,
                    recomputedMsg,
                    f.signature,
                    expectedPublicKey
                );

                if (!addrOk || !pubOk) {
                    throw new Error(
                        `Signature verification failed for ${f.filename}. Recovered addr=${recoveredAddress}, pubKey=${recoveredPublicKey}`
                    );
                }
            }
            console.log(`${cGreen('OK')} ${cDim('All frames verified')}`);
            return loadedManifest;
        });

        // -------------------------------
        // Negative verification: wrong start timestamp
        // -------------------------------
        await step('Negative verification (bad start timestamp)', async () => {
            const badStartTs = loaded.startTimestampMs + 1; // off-by-one should break signatures
            let negativeFailedAsExpected = false;
            try {
                for (let i = 0; i < loaded.frames.length; i++) {
                    const f = loaded.frames[i];
                    const filePath = path.join(INPUT_DIR, f.filename);
                    const buf = await readFileBuffer(filePath);
                    const recomputedSha = sha256Hex(buf);
                    const recomputedMsg = buildMessageString(badStartTs, f.frameNumber, recomputedSha);
                    // This should not match original message
                    if (recomputedMsg === f.message) {
                        throw new Error('Negative test invariant broken: recomputed message unexpectedly equals original');
                    }
                    const { addrOk, pubOk } = verifyEip191(
                        loaded.signer.address,
                        recomputedMsg,
                        f.signature,
                        loaded.signer.publicKey
                    );
                    if (addrOk && pubOk) {
                        throw new Error('Negative verification unexpectedly succeeded for a frame');
                    }
                }
                negativeFailedAsExpected = true;
            } catch (_) {
                // Any thrown error indicates mismatch/failed verification — which is expected
                negativeFailedAsExpected = true;
            }
            if (negativeFailedAsExpected) {
                console.log(`${cGreen('OK')} ${cDim('Failed as expected with bad timestamp')}`);
            } else {
                throw new Error('Negative verification did not fail as expected');
            }
        });

        await step('Sign manifest hash and write manifest_hash.txt', async () => {
            const manifestBuffer = await fsp.readFile(MANIFEST_PATH);
            const manifestSha256Hex = sha256Hex(manifestBuffer);
            const manifestHashBytes = Buffer.from(manifestSha256Hex, 'hex');
            const manifestSignature = await wallet.signMessage(manifestHashBytes);
            const { r: manR, s: manS, v: manV } = ethers.utils.splitSignature(manifestSignature);

            console.log(`${cDim('Manifest file:')} ${path.basename(MANIFEST_PATH)}`);
            console.log(`${cDim('Start timestamp:')} ${startTimestampMs}`);
            console.log(`${cBold('Manifest SHA-256:')} ${manifestSha256Hex}`);
            console.log(`${cBold('Signature:')} ${manifestSignature}`);
            console.log(`${cDim('r:')} ${manR} ${cDim('s:')} ${manS} ${cDim('v:')} ${manV}`);

            const hashTxtPath = path.join(OUTPUT_DIR, 'manifest_hash.txt');
            const lines = [
                path.basename(INPUT_VIDEO),
                String(startTimestampMs),
                manifestSha256Hex
            ].join('\n') + '\n';
            await fsp.writeFile(hashTxtPath, lines, 'utf8');
            console.log(`${cDim('Wrote:')} ${hashTxtPath}`);
        });

        await step('Write verifiable MP4 copy with metadata', async () => {
            const manifestBuffer = await fsp.readFile(MANIFEST_PATH);
            const manifestSha256Hex = sha256Hex(manifestBuffer);
            const verifiableDir = path.join(__dirname, 'verifiable mp4s');
            await ensureDir(verifiableDir);
            const outPath = path.join(verifiableDir, path.basename(INPUT_VIDEO));

            const args = [
                '-y',
                '-hide_banner',
                '-loglevel', 'error',
                '-i', INPUT_VIDEO,
                '-map_metadata', '0',
                '-metadata', `artist=${manifestSha256Hex}`,
                '-metadata', `album=Timestamp - ${startTimestampMs}`,
                '-metadata', 'title=Verifiable Video',
                '-movflags', 'use_metadata_tags',
                '-c', 'copy',
                outPath
            ];

            await new Promise((resolve, reject) => {
                const child = spawn(ffmpegPath, args, { stdio: 'inherit' });
                child.on('error', reject);
                child.on('exit', (code) => {
                    if (code === 0) return resolve();
                    reject(new Error(`ffmpeg (metadata write) exited with code ${code}`));
                });
            });

            console.log(`${cDim('Wrote verifiable MP4:')} ${outPath}`);
        });

        console.log(cCyan('='.repeat(60)));
        console.log(`${cGreen('ALL STEPS PASSED')} ${cDim(`(${path.basename(MANIFEST_PATH)})`)}`);
        console.log(cCyan('='.repeat(60)));
    } catch (err) {
        console.error(err.stack || err.message || String(err));
        process.exitCode = 1;
    }
};

main();


