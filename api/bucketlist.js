/**
 * Serverless endpoint for the Sổ Vé ticket book
 * (https://nguyenhoang88502.github.io/saigon_bucketlist/).
 *
 * POST /api/bucketlist  { task, ... }
 *
 *   task: "normalize"  { raw?, ten?, mota?, diachi?, vocab }
 *       -> { item: { ten, mota, diachi, category, mood[] }, notes }
 *         Cleans up whatever the user typed so everything written to the
 *         Google Sheet is phrased and labelled consistently.
 *
 *   task: "geocode"    { address }
 *       -> { lat, lng, display } | { lat: null }
 *         OpenStreetMap / Nominatim, called server-side so the browser never
 *         hits their rate limit directly and no key is needed.
 *
 *   task: "query"      { q, vocab, hasLocation }
 *       -> { category, moods[], maxKm, status, keywords[], note }
 *         Turns a free-text search ("quan ca phe yen tinh gan day") into the
 *         same filter facets the app already applies locally, so one typed
 *         sentence replaces every chip row.
 *
 *   task: "suggest"    { answers, places[] }
 *       -> { picks: [{ id, reason }] }
 *         Ranks candidate places against the onboarding answers.
 *
 *   task: "chat"       { messages[] }
 *       -> { text }
 */

import {
  applyCors,
  callDeepSeek,
  callJson,
  extractJson,
  sanitizeMessages,
  JsonCallError,
  fail,
} from './_shared.js';

const CATEGORY_FALLBACK = [
  { v: 'eat', label: 'Ăn uống' },
  { v: 'hangout', label: 'Gặp gỡ' },
  { v: 'casual', label: 'Thư giãn' },
  { v: 'adventure', label: 'Phiêu lưu' },
  { v: 'culture', label: 'Văn hoá' },
  { v: 'selfcare', label: 'Chăm sóc' },
];
const MOOD_FALLBACK = [
  'Ấm áp', 'Thư giãn', 'Vui nhộn', 'Hoài niệm',
  'Chăm sóc bản thân', 'Kết nối', 'Phiêu lưu', 'Ngắm cảnh đẹp',
];

/** Saigon bounding box, used to keep geocoding results in the right city. */
const SAIGON_VIEWBOX = '106.36,11.16,107.03,10.36';

function vocabOf(body) {
  const cats = Array.isArray(body?.vocab?.categories) && body.vocab.categories.length
    ? body.vocab.categories
        .map((c) => ({ v: String(c.v || '').trim(), label: String(c.label || '').trim() }))
        .filter((c) => c.v)
    : CATEGORY_FALLBACK;
  const moods = Array.isArray(body?.vocab?.moods) && body.vocab.moods.length
    ? body.vocab.moods.map((m) => String(m).trim()).filter(Boolean)
    : MOOD_FALLBACK;
  return { cats, moods };
}

async function taskNormalize(body) {
  const { cats, moods } = vocabOf(body);
  const raw = String(body.raw || '').slice(0, 2000);
  const ten = String(body.ten || '').slice(0, 300);
  const mota = String(body.mota || '').slice(0, 1000);
  const diachi = String(body.diachi || '').slice(0, 500);
  if (!raw && !ten) return { error: 'nothing_to_normalize' };

  const system = [
    'Bạn là bộ chuẩn hoá dữ liệu cho một sổ tay địa điểm ở Sài Gòn (TP.HCM).',
    'Nhiệm vụ: biến thông tin người dùng nhập lộn xộn thành một bản ghi sạch, nhất quán.',
    '',
    'Quy tắc:',
    '- "ten": tên riêng của chỗ đó, viết hoa đúng, bỏ từ thừa như "quán", "đi", "ăn ở" nếu không thuộc tên. Ngắn gọn, tối đa 60 ký tự.',
    '- "mota": đúng MỘT câu tiếng Việt, tối đa 120 ký tự, mô tả chỗ đó có gì. Không lặp lại tên. Để "" nếu không suy ra được.',
    '- "diachi": địa chỉ đầy đủ dạng "số nhà đường, phường, quận, TP.HCM". Chuẩn hoá viết tắt (Q1 -> Quận 1, P.5 -> Phường 5, Đ. -> Đường). Nếu không rõ thì để "".',
    `- "category": chọn ĐÚNG một giá trị trong: ${cats.map((c) => `${c.v} (${c.label})`).join(', ')}.`,
    `- "mood": chọn 1-2 giá trị, chỉ được lấy từ danh sách: ${moods.join(', ')}.`,
    '- Không bịa địa chỉ. Không thêm thông tin không có trong dữ liệu vào.',
    '',
    'Trả về DUY NHẤT một object JSON: {"ten":"","mota":"","diachi":"","category":"","mood":[]}',
  ].join('\n');

  const user = [
    raw ? `Người dùng nhập tự do:\n${raw}` : '',
    ten ? `Tên: ${ten}` : '',
    mota ? `Mô tả: ${mota}` : '',
    diachi ? `Địa chỉ: ${diachi}` : '',
  ].filter(Boolean).join('\n');

  const parsed = await callJson({
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 700,
    temperature: 0.2,
  });

  const catValues = cats.map((c) => c.v);
  const item = {
    ten: String(parsed.ten || ten || '').slice(0, 120).trim(),
    mota: String(parsed.mota || '').slice(0, 200).trim(),
    diachi: String(parsed.diachi || '').slice(0, 300).trim(),
    category: catValues.includes(parsed.category) ? parsed.category : (catValues[0] || 'casual'),
    mood: Array.isArray(parsed.mood)
      ? parsed.mood.map(String).filter((m) => moods.includes(m)).slice(0, 2)
      : [],
  };
  if (!item.ten) return { error: 'nothing_to_normalize' };
  if (!item.mood.length) item.mood = [moods[0]];
  return { item };
}

async function taskGeocode(body) {
  const address = String(body.address || '').trim().slice(0, 300);
  if (!address) return { lat: null, lng: null, display: '' };

  const q = /h[oò]\s*ch[ií]\s*minh|tp\.?\s*hcm|s[aà]i\s*g[oò]n/i.test(address)
    ? address
    : `${address}, Thành phố Hồ Chí Minh, Việt Nam`;

  const url =
    'https://nominatim.openstreetmap.org/search' +
    `?format=jsonv2&limit=1&countrycodes=vn&viewbox=${SAIGON_VIEWBOX}&bounded=0` +
    `&q=${encodeURIComponent(q)}`;

  // Nominatim first -- it is authoritative and free. If it is unreachable,
  // rate-limited, or has never heard of the place, fall back to the model,
  // which is good enough to put a pin on the right block of Saigon.
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim requires an identifying UA; anonymous requests get blocked.
        'User-Agent': 'SoVe-SaigonBucketlist/1.0 (https://nguyenhoang88502.github.io/saigon_bucketlist/)',
        'Accept-Language': 'vi,en',
      },
      signal: AbortSignal.timeout(7000),
    });
    if (res.ok) {
      const arr = await res.json();
      const hit = Array.isArray(arr) && arr[0];
      if (hit) {
        const lat = Number(hit.lat);
        const lng = Number(hit.lon);
        if (inSaigon(lat, lng)) {
          return { lat, lng, display: String(hit.display_name || ''), source: 'osm' };
        }
      }
    }
  } catch (err) {
    console.error('[proxy] nominatim unavailable:', err?.message || err);
  }

  return await geocodeWithModel(address);
}

/** Saigon-ish sanity box, so a bad hit never lands a pin in another province. */
function inSaigon(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat > 10.3 && lat < 11.2 && lng > 106.3 && lng < 107.1;
}

async function geocodeWithModel(address) {
  const system = [
    'Bạn là công cụ tra toạ độ cho các địa điểm ở Sài Gòn (TP.HCM, Việt Nam).',
    'Từ địa chỉ được cho, ước lượng toạ độ chính xác nhất có thể.',
    'Nếu không đủ thông tin để xác định, trả về null cho cả hai.',
    'Chỉ trả về JSON: {"lat": number|null, "lng": number|null}',
  ].join('\n');

  try {
    const parsed = await callJson({
      system,
      messages: [{ role: 'user', content: address }],
      maxTokens: 160,
      temperature: 0,
    });
    const lat = Number(parsed.lat);
    const lng = Number(parsed.lng);
    if (inSaigon(lat, lng)) return { lat, lng, display: address, source: 'ai' };
  } catch (err) {
    console.error('[proxy] model geocode failed:', err?.message || err);
  }
  return { lat: null, lng: null, display: '', source: 'none' };
}

async function taskQuery(body) {
  const { cats, moods } = vocabOf(body);
  const q = String(body.q || '').trim().slice(0, 400);
  if (!q) return { error: 'empty_query' };
  const hasLocation = !!body.hasLocation;

  const system = [
    'Bạn là bộ phân tích câu tìm kiếm cho "Sổ Vé" — sổ tay địa điểm ở Sài Gòn.',
    'Người dùng gõ một câu tự nhiên. Việc của bạn là dịch nó thành bộ lọc.',
    '',
    'Quy tắc:',
    `- "category": ĐÚNG một trong ${cats.map((c) => `${c.v} (${c.label})`).join(', ')}, hoặc "all" nếu câu không nghiêng hẳn về nhóm nào.`,
    `- "moods": 0-2 giá trị, chỉ lấy từ: ${moods.join(', ')}. Để [] nếu không rõ tâm trạng.`,
    '- "maxKm": số km nếu người dùng nói "gần đây", "gần tôi", "quanh đây" (gần đây = 3), hoặc nêu số km cụ thể. Ngược lại 0.',
    hasLocation
      ? '- Người dùng ĐANG bật vị trí, nên dùng maxKm thoải mái khi câu có ý "gần".'
      : '- Người dùng CHƯA bật vị trí; vẫn đặt maxKm nếu câu có ý "gần", app sẽ tự hỏi quyền.',
    '- "status": "visited" nếu họ muốn xem lại chỗ đã ghé, "new" nếu muốn chỗ chưa ghé, ngược lại "all".',
    '- "keywords": 1-4 từ khoá tiếng Việt ngắn để dò trong tên/mô tả/địa chỉ (vd "cà phê", "quận 1", "hoàng hôn").',
    '  Chỉ lấy từ khoá thật sự có khả năng xuất hiện trong tên hoặc địa chỉ. Bỏ từ chỉ tâm trạng — cái đó đã nằm ở "moods".',
    '  Nếu câu quá chung chung thì để [].',
    '- "note": một câu tiếng Việt tối đa 70 ký tự, nói bạn hiểu họ muốn gì.',
    '- Không bịa nhãn ngoài danh sách trên.',
    '',
    'Trả về DUY NHẤT: {"category":"","moods":[],"maxKm":0,"status":"all","keywords":[],"note":""}',
  ].join('\n');

  const parsed = await callJson({
    system,
    messages: [{ role: 'user', content: q }],
    maxTokens: 400,
    temperature: 0.1,
  });

  const catValues = cats.map((c) => c.v);
  return {
    category: catValues.includes(parsed.category) ? parsed.category : 'all',
    moods: Array.isArray(parsed.moods)
      ? parsed.moods.map(String).filter((m) => moods.includes(m)).slice(0, 2)
      : [],
    maxKm: Number.isFinite(Number(parsed.maxKm)) ? Math.min(Math.max(Number(parsed.maxKm), 0), 50) : 0,
    status: ['all', 'visited', 'new'].includes(parsed.status) ? parsed.status : 'all',
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 4)
      : [],
    note: String(parsed.note || '').slice(0, 140),
  };
}

async function taskSuggest(body) {
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const places = Array.isArray(body.places) ? body.places.slice(0, 120) : [];
  if (!places.length) return { picks: [] };

  const compact = places.map((p) => ({
    id: String(p.id || '').slice(0, 60),
    ten: String(p.ten || '').slice(0, 90),
    category: String(p.category || '').slice(0, 20),
    mood: Array.isArray(p.mood) ? p.mood.slice(0, 3) : [],
    khu: String(p.khu || p.diachi || '').slice(0, 90),
    km: typeof p.km === 'number' ? Math.round(p.km * 10) / 10 : null,
    daDi: !!p.daDi,
  }));

  const system = [
    'Bạn giúp chọn chỗ đi chơi ở Sài Gòn dựa trên tâm trạng và hoàn cảnh của người dùng.',
    'Bạn nhận một danh sách ứng viên và phải xếp hạng chúng.',
    '',
    'Quy tắc:',
    '- Chỉ được chọn id có trong danh sách. Tuyệt đối không bịa id mới.',
    '- Trả về tối đa 5 gợi ý, tốt nhất xếp trước.',
    '- Ưu tiên chỗ hợp tâm trạng và hoàn cảnh; nếu có "km" thì ưu tiên chỗ gần hơn khi người dùng muốn đi gần.',
    '- Chỗ có "daDi": true là đã ghé rồi — vẫn được gợi ý nhưng xếp sau, trừ khi rất hợp.',
    '- "reason": một câu tiếng Việt tối đa 90 ký tự, nói vì sao hợp.',
    '',
    'Trả về DUY NHẤT: {"picks":[{"id":"","reason":""}]}',
  ].join('\n');

  const user =
    `Câu trả lời của người dùng:\n${JSON.stringify(answers, null, 1)}\n\n` +
    `Ứng viên:\n${JSON.stringify(compact)}`;

  let parsed = null;
  try {
    parsed = await callJson({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 900,
      temperature: 0.4,
    });
  } catch (err) {
    console.error('[proxy] suggest failed:', err?.message || err);
    return { picks: [] };
  }

  const valid = new Set(compact.map((p) => p.id));
  const picks = Array.isArray(parsed?.picks)
    ? parsed.picks
        .filter((p) => p && valid.has(String(p.id)))
        .slice(0, 5)
        .map((p) => ({ id: String(p.id), reason: String(p.reason || '').slice(0, 140) }))
    : [];
  return { picks };
}

async function taskChat(body) {
  const messages = sanitizeMessages(body.messages, { maxMessages: 12 });
  if (!messages.length) return { error: 'no_messages' };

  const places = Array.isArray(body.places) ? body.places.slice(0, 120) : [];
  const system = [
    'Bạn là trợ lý của "Sổ Vé" — sổ tay những chỗ đáng ghé ở Sài Gòn của Hoàng.',
    'Bạn giúp người dùng chọn chỗ đi chơi, gợi ý theo tâm trạng, khoảng cách, nhóm hoạt động.',
    'Trả lời bằng tiếng Việt, ngắn gọn, thân thiện, đi thẳng vào gợi ý cụ thể.',
    'Chỉ nói về những chỗ có trong sổ dưới đây. Nếu sổ không có gì hợp, nói thẳng và gợi ý nới điều kiện.',
    'Không bịa địa chỉ hay chỗ không có trong danh sách.',
    '',
    `Sổ vé hiện có ${places.length} chỗ:`,
    JSON.stringify(places.map((p) => ({
      ten: String(p.ten || '').slice(0, 90),
      category: p.category,
      mood: p.mood,
      diachi: String(p.diachi || '').slice(0, 90),
      daDi: !!p.daDi,
    }))),
  ].join('\n');

  const text = await callDeepSeek({ system, messages, maxTokens: 1200, temperature: 0.6 });
  return { text };
}

export default async function handler(request, response) {
  if (applyCors(request, response)) return;

  const body = request.body && typeof request.body === 'object' ? request.body : {};
  const task = String(body.task || '').toLowerCase();

  try {
    let result;
    switch (task) {
      case 'normalize': result = await taskNormalize(body); break;
      case 'geocode':   result = await taskGeocode(body);   break;
      case 'query':     result = await taskQuery(body);    break;
      case 'suggest':   result = await taskSuggest(body);  break;
      case 'chat':      result = await taskChat(body);      break;
      default:
        return fail(response, 400, 'unknown_task', task);
    }
    if (result && result.error) return fail(response, 422, result.error);
    return response.status(200).json(result);
  } catch (err) {
    if (err instanceof JsonCallError) {
      console.error('[proxy] model output was not JSON:', err.raw);
      return response.status(422).json({ error: 'unparseable_model_output', raw: err.raw });
    }
    const msg = String(err?.message || err);
    if (msg === 'missing_api_key') return fail(response, 500, 'ai_not_configured', msg);
    return fail(response, 502, 'upstream_failed', msg);
  }
}
