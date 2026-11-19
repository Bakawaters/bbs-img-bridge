import { composeScene } from '../src/scene.js';
import fs from 'node:fs';

const COMFY = 'http://127.0.0.1:8188';
const OUTDIR = 'G:/Workbuddy/MOSS/out';

const snapSingle = {
  revision: 1,
  state: { time: '2026-11-19 21:40', location: '城南旧书店二楼', locationPath: ['城南', '旧书店', '二楼'], sceneFocus: { situation: '林夏靠着书架翻一本旧画册', participants: ['林夏'] } },
  protagonist: { gender: '女', appearance: '', outfit: '灰色针织衫' },
  scenes: [{ name: '二楼', desc: '木质地板的老书店二楼，成排到顶的书架，暖黄壁灯' }],
  npcs: [],
};

const snapPair = {
  revision: 2,
  state: { time: '2026-11-19 22:10', location: '城南旧书店二楼', locationPath: ['城南', '旧书店', '二楼'], sceneFocus: { situation: '沈砚从背后环抱住林夏的腰，两人贴得很近，林夏侧头微笑', participants: ['林夏', '沈砚'] } },
  protagonist: { gender: '女', appearance: '', outfit: '灰色针织衫' },
  scenes: [{ name: '二楼', desc: '木质地板的老书店二楼，成排到顶的书架，暖黄壁灯' }],
  npcs: [
    { name: '林夏', gender: '女', desc: '黑色短发，琥珀色眼睛，皮肤偏白，个子不高', outfit: '灰色针织衫' },
    { name: '沈砚', gender: '女', desc: '亚麻色长卷发，浅褐色眼睛，身形高瘦', outfit: '深蓝色衬衫', condition: '' },
  ],
};

const snapTriple = {
  revision: 3,
  state: { time: '2026-11-19 19:20', location: '老街咖啡馆', locationPath: ['老街'], sceneFocus: { situation: '三人并排站在吧台前等咖啡，林夏低头看手机', participants: ['林夏', '沈砚', '周棠'] } },
  protagonist: { gender: '女', appearance: '', outfit: '米色外套' },
  scenes: [{ name: '老街', desc: '临街的老咖啡馆，木质吧台，暖黄吊灯，玻璃窗外是雨后的石板路' }],
  npcs: [
    { name: '林夏', gender: '女', desc: '黑色短发，琥珀色眼睛，皮肤偏白', outfit: '米色外套' },
    { name: '沈砚', gender: '女', desc: '亚麻色长卷发，浅褐色眼睛，身形高瘦', outfit: '深蓝色衬衫' },
    { name: '周棠', gender: '男', desc: '寸头，眉骨高，左耳有耳钉，肩宽', outfit: '黑色夹克' },
  ],
};

const cards = { '__user__': '一位年轻女性，黑色长发扎成低马尾' };

function wf(text, tag, w, h) {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'moss_image_sft_int8_convrot.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3.5_9b_w4a8_gptq.safetensors', type: 'moss_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae_small.safetensors' } },
    4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text } },
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
    6: { class_type: 'EmptyFlux2LatentImage', inputs: { width: w, height: h, batch_size: 1 } },
    7: { class_type: 'KSampler', inputs: { model: ['10', 0], seed: 918273, steps: 8, cfg: 1.0, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1.0, positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: tag } },
    10: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'moss_dmd8_lora.safetensors', strength_model: 1.0 } },
  };
}

async function run(tag, text, w, h) {
  const r = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf(text, tag, w, h), client_id: 'scn' }) });
  const { prompt_id } = await r.json();
  const t0 = Date.now();
  while (Date.now() - t0 < 600000) {
    await new Promise(res => setTimeout(res, 1200));
    const hh = await (await fetch(`${COMFY}/history/${prompt_id}`)).json();
    if (hh[prompt_id]) {
      const dt = (Date.now() - t0) / 1000;
      const files = Object.values(hh[prompt_id].outputs).flatMap(n => n.images || []).map(i => i.filename);
      console.log(`  ${tag}: ${dt.toFixed(1)}s -> ${files.join(',')}`);
      return files[0];
    }
  }
  console.log(`${tag} TIMEOUT`);
  return null;
}

const cases = [
  ['scn_single', snapSingle],
  ['scn_pair', snapPair],
  ['scn_triple', snapTriple],
];

for (const [tag, snap] of cases) {
  const res = composeScene({ snapshot: snap, cards });
  console.log(`\n=== ${tag} mode=${res.mode} ${res.width}x${res.height} ===`);
  console.log('report:', res.report.join(' | '));
  console.log('text:', res.text);
  fs.writeFileSync(`${OUTDIR}/${tag}.txt`, res.text, 'utf8');
  const file = await run(tag, res.text, res.width, res.height);
  if (file) fs.copyFileSync(`G:/A/ComfyUI_windows_portable/ComfyUI/output/${file}`, `${OUTDIR}/${tag}.png`);
}
