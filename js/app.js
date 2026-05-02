/**
 * AI职业陪跑系统 v2.1 — 主应用逻辑
 * 6模块：职业定位 | 职业路线 | 职业能力 | 职业实战 | 职业复盘 | 入职陪跑
 * 激活系统 + 云端同步
 */

// ============================================================
// 激活码验证系统
// ============================================================
const SECRET = "miaohan1913_AI_2026_KEY";
const GH_TOKEN = localStorage.getItem('gh_sync_token') || '';
const GIST_DESC = 'AI职业陪跑-跨设备状态同步';
const GIST_FILENAME = 'career-coach-state.json';
let gistETag = null;
let currentSession = null;

function decrypt(encoded, key) {
  try {
    encoded = encoded.replace(/[._]/g, c => ({'.':'+','_':'/'}[c]));
    while (encoded.length % 4) encoded += '=';
    var bytes = atob(encoded);
    var result = '';
    for (var i = 0; i < bytes.length; i += 2) {
      var hi = bytes.charCodeAt(i) & 0xFF;
      var lo = bytes.charCodeAt(i + 1) & 0xFF;
      var c = (hi << 8) | lo;
      result += String.fromCharCode(c ^ key.charCodeAt((i / 2) % key.length));
    }
    return result;
  } catch(e) { return ''; }
}

function simpleHash(str) {
  var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (var i = 0; i < str.length; i++) {
    var ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 3266489909);
  return (h1 ^ h2) >>> 0;
}

function validateCode(rawCode) {
  var clean = rawCode.replace(/[-\s]/g, '');
  if (clean.length < 12) return { valid: false, error: '激活码格式错误' };
  var hashPart = clean.slice(-4).toUpperCase();
  var dataPart = clean.slice(0, -4);
  var expectedHash = simpleHash(dataPart + SECRET).toString(16).slice(0, 4).toUpperCase();
  if (hashPart !== expectedHash) return { valid: false, error: '激活码无效' };
  var payload = decrypt(dataPart, SECRET);
  if (!payload) return { valid: false, error: '激活码数据损坏' };
  var parts = payload.split('|');
  if (parts.length < 4) return { valid: false, error: '激活码数据损坏' };
  var expiryStr = parts[0];
  var maxUses = parseInt(parts[1]);
  var userName = parts[2];
  var maxWechatUsers = parts.length >= 5 ? (parseInt(parts[4]) || 0) : 0;
  var expiry = new Date(expiryStr + 'T23:59:59');
  if (new Date() > expiry) return { valid: false, error: '激活码已于 ' + expiryStr + ' 过期' };
  return { valid: true, userName: userName, expiry: expiryStr, maxUses: maxUses, maxWechatUsers: maxWechatUsers, expiryDate: expiry };
}

// ========== GitHub Gist API（跨设备共享状态）==========
function ghApi(path, options) {
  if (!GH_TOKEN) return Promise.resolve(null);
  options = options || {};
  options.headers = options.headers || {};
  options.headers['Authorization'] = 'Bearer ' + GH_TOKEN;
  options.headers['Accept'] = 'application/vnd.github.v3+json';
  if (options.body && typeof options.body === 'object') {
    options.body = JSON.stringify(options.body);
  }
  return fetch('https://api.github.com' + path, options)
    .then(function(r){ return r.json(); })
    .catch(function(){ return null; });
}

function getOrCreateGist() {
  var cached = localStorage.getItem('gist_sync_id');
  if (cached) return Promise.resolve(cached);
  if (!GH_TOKEN) return Promise.resolve(null);
  return ghApi('/gists?per_page=50').then(function(gists) {
    if (gists && Array.isArray(gists)) {
      var found = gists.find(function(g){ return g.description === GIST_DESC; });
      if (found) { localStorage.setItem('gist_sync_id', found.id); return found.id; }
    }
    var files = {}; files[GIST_FILENAME] = {content: JSON.stringify({codes:{}})};
    return ghApi('/gists', { method: 'POST', body: { description: GIST_DESC, public: false, files: files } })
      .then(function(g) { if (g && g.id) { localStorage.setItem('gist_sync_id', g.id); return g.id; } return null; });
  });
}

function readSharedState(gistId) {
  return ghApi('/gists/' + gistId).then(function(gist) {
    if (gist && gist.files && gist.files[GIST_FILENAME]) {
      try { return JSON.parse(gist.files[GIST_FILENAME].content); } catch(e) {}
    }
    return { codes: {} };
  });
}

function readSharedStateWithETag(gistId) {
  if (!GH_TOKEN) return Promise.resolve(null);
  return fetch('https://api.github.com/gists/' + gistId, {
    headers: { 'Authorization': 'Bearer ' + GH_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
  }).then(function(r) {
    var etag = r.headers.get('ETag') || r.headers.get('etag') || '';
    if (etag) gistETag = etag.replace(/^[WL]\/"?|"$/g, '');
    return r.json();
  }).then(function(gist) {
    if (gist && gist.files && gist.files[GIST_FILENAME]) {
      try { return JSON.parse(gist.files[GIST_FILENAME].content); } catch(e) {}
    }
    return { codes: {} };
  }).catch(function(){ return { codes: {} }; });
}

function writeSharedState(gistId, state) {
  var headers = {};
  if (gistETag) { headers['If-Match'] = gistETag; gistETag = null; }
  var files = {}; files[GIST_FILENAME] = {content: JSON.stringify(state)};
  return ghApi('/gists/' + gistId, { method: 'PATCH', headers: headers, body: { files: files } });
}

// ========== 使用次数追踪 ==========
function getUsageKey(code) {
  return 'usage_' + simpleHash(code.replace(/[-\s]/g, '').toUpperCase()).toString(16);
}
function getUsage(code) {
  return JSON.parse(localStorage.getItem(getUsageKey(code)) || '{"uses":0,"firstUse":null}');
}
function incrementUsage(code) {
  var key = getUsageKey(code);
  var data = getUsage(code);
  data.uses++;
  if (!data.firstUse) data.firstUse = new Date().toISOString().slice(0, 10);
  localStorage.setItem(key, JSON.stringify(data));
  return data;
}

function useOneCredit(onSuccess, onFail) {
  if (!currentSession) { if (onFail) onFail('会话已过期，请刷新页面重新激活'); return false; }
  var usage = getUsage(currentSession.code);
  if (currentSession.maxUses > 0 && usage.uses >= currentSession.maxUses) {
    if (onFail) onFail('使用次数已用完，请联系续费');
    return false;
  }
  incrementUsage(currentSession.code);
  refreshUsageDisplay();
  if (GH_TOKEN) {
    getOrCreateGist().then(function(gistId) {
      if (!gistId) return;
      return readSharedStateWithETag(gistId).then(function(state) {
        var ch = currentSession.code.replace(/[-\s]/g, '').toUpperCase();
        var hash = simpleHash(ch).toString(16);
        var cs = state.codes[hash];
        if (!cs) {
          cs = { wechatIds: [], uses: 0, maxUses: currentSession.maxUses, maxWechatUsers: currentSession.maxWechatUsers, expiry: currentSession.expiry, userName: currentSession.userName };
          state.codes[hash] = cs;
        }
        cs.uses = Math.max(cs.uses, getUsage(currentSession.code).uses);
        return writeSharedState(gistId, state);
      });
    }).catch(function(){});
  }
  if (onSuccess) onSuccess();
  return true;
}

function refreshUsageDisplay() {
  if (!currentSession) return;
  var elU = document.getElementById('remainingUses');
  var elE = document.getElementById('expiryDate');
  if (elU) elU.textContent = currentSession.maxUses === 0 ? '不限' : (currentSession.maxUses - getUsage(currentSession.code).uses);
  if (elE) elE.textContent = currentSession.expiry;
}

// ========== 微信绑定 ==========
function getWechatBindingsKey(code) {
  return 'wxb_' + simpleHash(code.replace(/[-\s]/g, '').toUpperCase()).toString(16);
}
function getWechatBindings(code) {
  try { return JSON.parse(localStorage.getItem(getWechatBindingsKey(code)) || '[]'); } catch(e) { return []; }
}
function saveWechatBindings(code, list) {
  localStorage.setItem(getWechatBindingsKey(code), JSON.stringify(list));
}

function saveWechat() {
  var wx = document.getElementById('wechatInput').value.trim();
  if (!wx && currentSession.maxWechatUsers > 0) {
    document.getElementById('wechatBindErr').textContent = '此激活码需要绑定微信号才能使用，请输入微信号';
    return;
  }
  var btn = document.querySelector('.wechat-bind-card .btn-save');
  if (wx && currentSession.maxWechatUsers > 0) {
    var bindings = getWechatBindings(currentSession.code);
    if (bindings.indexOf(wx) === -1) {
      if (bindings.length >= currentSession.maxWechatUsers) {
        document.getElementById('wechatBindErr').textContent = '该激活码已达人数上限（最多' + currentSession.maxWechatUsers + '人）';
        return;
      }
    }
    if (GH_TOKEN) {
      btn.textContent = '云端验证中...';
      btn.disabled = true;
      getOrCreateGist().then(function(gistId) {
        if (!gistId) { failFallback('网络异常，请稍后重试'); return; }
        return readSharedStateWithETag(gistId).then(function(state) {
          var ch = currentSession.code.replace(/[-\s]/g, '').toUpperCase();
          var hash = simpleHash(ch).toString(16);
          var cs = state.codes[hash];
          if (!cs) {
            cs = { wechatIds:[], uses:0, maxUses:currentSession.maxUses, maxWechatUsers:currentSession.maxWechatUsers, expiry:currentSession.expiry, userName:currentSession.userName };
            state.codes[hash] = cs;
          }
          cs.maxUses = currentSession.maxUses;
          cs.maxWechatUsers = currentSession.maxWechatUsers;
          cs.expiry = currentSession.expiry;
          if (cs.wechatIds.indexOf(wx) === -1) {
            if (cs.wechatIds.length >= cs.maxWechatUsers) {
              failFallback('已达人数上限（最多' + cs.maxWechatUsers + '人）');
              return;
            }
            cs.wechatIds.push(wx);
          }
          return writeSharedState(gistId, state).then(function() {
            var usage = getUsage(currentSession.code);
            usage.uses = cs.uses;
            localStorage.setItem(getUsageKey(currentSession.code), JSON.stringify(usage));
            saveWechatBindings(currentSession.code, cs.wechatIds);
            localStorage.setItem('bound_wechat', wx);
            document.getElementById('wechatBindOverlay').classList.remove('show');
            enterApp();
          });
        });
      }).catch(function(){ failFallback('云端同步失败，请稍后重试'); });
      function failFallback(msg) {
        btn.textContent = '绑定，开始使用';
        btn.disabled = false;
        document.getElementById('wechatBindErr').textContent = msg;
      }
      return;
    }
    bindings.push(wx);
    saveWechatBindings(currentSession.code, bindings);
  }
  if (wx) {
    localStorage.setItem('bound_wechat', wx);
  }
  document.getElementById('wechatBindOverlay').classList.remove('show');
  enterApp();
}

function skipWechat() {
  if (currentSession.maxWechatUsers > 0) {
    document.getElementById('wechatBindErr').textContent = '此激活码需要绑定微信号才能使用';
    return;
  }
  document.getElementById('wechatBindOverlay').classList.remove('show');
  enterApp();
}

// ========== 登录/激活主流程 ==========
function activate() {
  var input = document.getElementById('activationInput').value.trim();
  var errEl = document.getElementById('loginErr');
  var btn = document.getElementById('activateBtn');
  if (!input) { errEl.textContent = '请输入激活码'; return; }

  var storageKey = 'activation_' + simpleHash(input.replace(/[-\s]/g, '').toUpperCase()).toString(16);
  var cached = localStorage.getItem(storageKey);
  var validation;
  if (cached) {
    validation = JSON.parse(cached);
    var fresh = validateCode(input);
    if (fresh.valid) {
      validation.maxUses = fresh.maxUses;
      validation.expiry = fresh.expiry;
      validation.maxWechatUsers = fresh.maxWechatUsers;
    }
    if (new Date() > new Date(validation.expiry + 'T23:59:59')) {
      localStorage.removeItem(storageKey);
      errEl.textContent = '激活码已过期，请续费';
      return;
    }
  } else {
    validation = validateCode(input);
    if (!validation.valid) { errEl.textContent = validation.error; return; }
    validation.rawCode = input;
    localStorage.setItem(storageKey, JSON.stringify(validation));
  }

  var usage = getUsage(input);
  if (validation.maxUses > 0 && usage.uses >= validation.maxUses) {
    errEl.textContent = '使用次数已用完，请联系续费';
    return;
  }

  currentSession = { code: input, userName: validation.userName, expiry: validation.expiry, maxUses: validation.maxUses, maxWechatUsers: validation.maxWechatUsers, storageKey: storageKey };

  btn.disabled = true;
  btn.textContent = '验证通过';

  var boundWx = localStorage.getItem('bound_wechat');
  if (validation.maxWechatUsers > 0 && !boundWx) {
    document.getElementById('wechatBindSubt').textContent = '该激活码限 ' + validation.maxWechatUsers + ' 人使用';
    document.getElementById('wechatBindBenefits').style.display = 'none';
    document.getElementById('wechatBindSkipBtn').style.display = 'none';
    document.getElementById('wechatInput').placeholder = '请输入微信号（必填，用于身份识别）';
    document.getElementById('wechatBindErr').textContent = '';
    document.getElementById('wechatBindOverlay').classList.add('show');
  } else if (boundWx) {
    btn.textContent = '激活成功！欢迎回来';
    setTimeout(function(){ enterApp(); }, 400);
  } else {
    document.getElementById('wechatBindSubt').textContent = '到期前微信自动提醒续费';
    document.getElementById('wechatBindBenefits').style.display = '';
    document.getElementById('wechatBindSkipBtn').style.display = '';
    document.getElementById('wechatInput').placeholder = '输入微信号（选填）';
    document.getElementById('wechatBindOverlay').classList.add('show');
  }
}

function enterApp() {
  localStorage.setItem('last_activation_code', currentSession.code);
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = '';
  document.getElementById('userName').textContent = '' + currentSession.userName;
  refreshUsageDisplay();
  var boundWx = localStorage.getItem('bound_wechat');
  var wxEl = document.getElementById('wechatBound');
  if (boundWx && wxEl) {
    wxEl.textContent = '微信：' + escapeHTML(boundWx);
    wxEl.style.display = '';
  }
  // 云端同步
  if (GH_TOKEN) {
    getOrCreateGist().then(function(gistId) {
      if (!gistId) return;
      return readSharedState(gistId).then(function(state) {
        var ch = currentSession.code.replace(/[-\s]/g, '').toUpperCase();
        var h = simpleHash(ch).toString(16);
        var cs = state.codes[h];
        if (cs) {
          var key = getUsageKey(currentSession.code);
          var usage = getUsage(currentSession.code);
          usage.uses = cs.uses;
          localStorage.setItem(key, JSON.stringify(usage));
          saveWechatBindings(currentSession.code, cs.wechatIds);
          refreshUsageDisplay();
        }
      });
    });
  }
  navTo('positioning');
}

function logout() {
  if (!confirm('确定要退出吗？\n\n退出后重新进入需要输入激活码。')) return;
  currentSession = null;
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('loginScreen').style.display = '';
  document.getElementById('activateBtn').disabled = false;
  document.getElementById('activateBtn').textContent = '激活使用';
  var lastCode = localStorage.getItem('last_activation_code');
  if (lastCode) {
    document.getElementById('activationInput').value = lastCode;
    document.getElementById('loginHint').style.display = '';
    document.getElementById('lastCodeHint').textContent = maskCode(lastCode);
  }
}

function fillLastCode() {
  var code = localStorage.getItem('last_activation_code');
  if (code) {
    document.getElementById('activationInput').value = code;
    document.getElementById('loginHint').style.display = 'none';
  }
}

function maskCode(code) {
  if (code.length <= 8) return code.substring(0, 2) + '****' + code.substring(code.length - 2);
  return code.substring(0, 4) + '****' + code.substring(code.length - 4);
}

// ========== 云端同步设置 ==========
function showTokenSetup() {
  var token = localStorage.getItem('gh_sync_token') || '';
  var newToken = prompt((token ? '当前已配置云端同步。\n\n输入新 Token 替换，或点取消保持现有设置：' : '输入 GitHub Token 开启云端同步（跨设备共享次数）：\n\n1. 打开 https://github.com/settings/tokens\n2. Generate new token (classic)\n3. 勾选 gist 权限\n4. 生成后粘贴到这里'), token);
  if (newToken !== null) {
    if (newToken.trim() === '') {
      localStorage.removeItem('gh_sync_token');
      alert('已清除云端同步设置。');
    } else {
      localStorage.setItem('gh_sync_token', newToken.trim());
      alert('云端同步已配置！刷新页面后生效。');
    }
    location.reload();
  }
}

// ========== 推荐人识别（URL ?ref=XXX）==========
(function(){
  var params = new URLSearchParams(window.location.search);
  var ref = params.get('ref');
  if (ref) {
    sessionStorage.setItem('referrer', ref);
    var tag = document.getElementById('refTag');
    var nameEl = document.getElementById('refName');
    if (tag && nameEl) { nameEl.textContent = decodeURIComponent(ref); tag.style.display = 'inline-block'; }
  } else {
    var saved = sessionStorage.getItem('referrer');
    if (saved) {
      var tag = document.getElementById('refTag');
      var nameEl = document.getElementById('refName');
      if (tag && nameEl) { nameEl.textContent = decodeURIComponent(saved); tag.style.display = 'inline-block'; }
    }
  }
})();

(function(){
  var lastCode = localStorage.getItem('last_activation_code');
  if (lastCode) {
    var hint = document.getElementById('loginHint');
    var span = document.getElementById('lastCodeHint');
    if (hint && span) { span.textContent = maskCode(lastCode); hint.style.display = ''; }
  }
})();

(function(){
  var el = document.getElementById('syncStatusLogin');
  if (el) {
    var token = localStorage.getItem('gh_sync_token');
    if (token) { el.textContent = '云端同步已开启 · 点击修改'; el.style.color = 'rgba(96,165,250,.7)'; }
  }
})();

// ============================================================
// 应用主逻辑（v2.0原有，v2.1调整初始化）
// ============================================================

const AppState = {
  currentModule: 'positioning',
  userData: {}
};

function loadState() {
  try {
    const s = localStorage.getItem('career_coach_v2');
    if (s) AppState.userData = JSON.parse(s);
  } catch(e) {}
}
function saveState() {
  localStorage.setItem('career_coach_v2', JSON.stringify(AppState.userData));
}

function navTo(mod) {
  AppState.currentModule = mod;
  document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
  document.querySelector(`.nav-item[data-module="${mod}"]`)?.classList.add('active');
  document.querySelectorAll('.module-content').forEach(e => e.classList.remove('active'));
  const target = document.getElementById(`module-${mod}`);
  if (target) target.classList.add('active');

  switch(mod) {
    case 'positioning': initPositioning(); break;
    case 'roadmap': initRoadmap(); break;
    case 'toolkit': initToolkit(); break;
    case 'combat': initCombat(); break;
    case 'review': initReview(); break;
    case 'onboarding': initOnboarding(); break;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================================================
// 模块1：职业定位
// ============================================================
function initPositioning() {
  renderFourQuadrants();
  renderAssetAudit();
  renderGoalClarification();
  renderRiskIdentification();
  restorePositioningData();
}

function renderFourQuadrants() {
  const container = document.getElementById('pos-four-quadrants');
  const quadrants = CAREER_POSITIONING.fourQuadrants;
  container.innerHTML = Object.entries(quadrants).map(([key, quad]) => `
    <div class="quadrant-card" id="quad-${key}">
      <div class="quadrant-header">
        <span class="quad-icon">${quad.icon}</span>
        <div>
          <h3>${quad.label}</h3>
          <p class="quad-question">${quad.question}</p>
        </div>
      </div>
      <div class="quad-dimensions">
        ${quad.dimensions.map(d => `
          <div class="quad-dim-item">
            <div class="qdi-header">
              <span class="qdi-name">${d.name}${d.critical ? ' 🔴' : ''}</span>
              <span class="qdi-score" id="score-${key}-${d.id}">-</span>
            </div>
            <p class="qdi-desc">${d.desc}</p>
            <input type="range" min="1" max="5" step="1" class="quad-slider"
              id="slider-${key}-${d.id}"
              oninput="updateScore('${key}','${d.id}')" onchange="savePositioningData()">
            <div class="range-labels"><span>1 弱</span><span>3 中</span><span>5 强</span></div>
            ${key === 'constraints' ? `<div class="constraint-detail"><input type="text" class="qdi-input" id="detail-${key}-${d.id}" placeholder="具体说明（如：不能低于X万/月、不能离开XX城市）" onchange="savePositioningData()"></div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function updateScore(key, id) {
  const val = document.getElementById(`slider-${key}-${id}`).value;
  const display = document.getElementById(`score-${key}-${id}`);
  if (display) display.textContent = val + '/5';
}

function renderAssetAudit() {
  const audit = CAREER_POSITIONING.assetAudit;
  const container = document.getElementById('pos-asset-audit');
  container.innerHTML = Object.entries(audit).map(([key, section]) => `
    <div class="asset-section">
      <h4>📦 ${section.label}</h4>
      ${section.items.map(item => `
        <div class="asset-item">
          <label>${item.name}</label>
          <p class="asset-prompt">${item.prompt}</p>
          <textarea class="asset-textarea" id="asset-${key}-${item.name}" rows="2" placeholder="如实盘点..." onchange="savePositioningData()"></textarea>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function renderGoalClarification() {
  const gc = CAREER_POSITIONING.goalClarification;
  const container = document.getElementById('pos-goal');
  container.innerHTML = `
    <div class="goal-section">
      <h4>🎯 ${gc.primaryGoal.label}</h4>
      <select id="goal-primary" class="goal-select" onchange="savePositioningData()">
        <option value="">--选择一个方向--</option>
        ${gc.primaryGoal.options.map(o => `<option value="${o}">${o}</option>`).join('')}
      </select>
      ${gc.primaryGoal.prompts.map((p, i) => `
        <div class="goal-prompt"><label>${p}</label><input type="text" class="goal-input" id="goal-p-${i}" placeholder="你的回答..." onchange="savePositioningData()"></div>
      `).join('')}
    </div>
    <div class="goal-section">
      <h4>🔄 ${gc.secondaryGoal.label}</h4>
      <select id="goal-secondary" class="goal-select" onchange="savePositioningData()">
        <option value="">--选择一个方向--</option>
        ${gc.secondaryGoal.options.map(o => `<option value="${o}">${o}</option>`).join('')}
      </select>
      ${gc.secondaryGoal.prompts.map((p, i) => `
        <div class="goal-prompt"><label>${p}</label><input type="text" class="goal-input" id="goal-s-${i}" placeholder="你的回答..." onchange="savePositioningData()"></div>
      `).join('')}
    </div>
  `;
}

function renderRiskIdentification() {
  const risk = CAREER_POSITIONING.riskIdentification;
  const container = document.getElementById('pos-risk');
  container.innerHTML = `
    <div class="risk-section">
      <h4>⚠️ ${risk.topWeaknesses.label}</h4>
      <p>${risk.topWeaknesses.description}</p>
      ${risk.topWeaknesses.prompts.map((p, i) => `<div class="risk-prompt"><label>${p}</label><input type="text" class="risk-input" id="risk-weak-${i}" placeholder="具体描述..." onchange="savePositioningData()"></div>`).join('')}
    </div>
    <div class="risk-section">
      <h4>🚫 ${risk.redLines.label}</h4>
      ${risk.redLines.categories.map(c => `
        <div class="redline-item">
          <strong>${c.name}</strong>
          <span class="redline-examples">例：${c.examples}</span>
          <input type="text" class="risk-input" id="risk-redline-${c.name}" placeholder="你的具体情况..." onchange="savePositioningData()">
        </div>
      `).join('')}
    </div>
  `;
}

function generatePositioningReport() {
  const data = collectPositioningData();
  const report = document.getElementById('pos-report');
  report.style.display = 'block';

  // 分析四象限交汇点
  const topAbility = getTop(data.ability, 3, CAREER_POSITIONING.fourQuadrants.ability.dimensions);
  const topInterest = getTop(data.interest, 3, CAREER_POSITIONING.fourQuadrants.interest.dimensions);
  const topValues = getTop(data.values, 3, CAREER_POSITIONING.fourQuadrants.values.dimensions);
  const criticalConstraints = Object.entries(data.constraints || {})
    .filter(([id, val]) => val >= 4)
    .map(([id]) => CAREER_POSITIONING.fourQuadrants.constraints.dimensions.find(d => d.id === id)?.name).filter(Boolean);

  report.innerHTML = `
    <div class="report-card report-positioning">
      <div class="report-title-row">
        <h2>📋 一页纸职业定位报告</h2>
        <span class="report-date">${new Date().toLocaleDateString('zh-CN')}</span>
      </div>

      <div class="report-grid-2col">
        <div class="report-block">
          <h3>💪 核心能力优势</h3>
          <div class="report-tags">${topAbility.map(a => `<span class="report-tag strength">${a.name}</span>`).join('')}</div>
          <p>你在<strong>${topAbility.map(a=>a.name).join('、')}</strong>方面具有明显优势。这些是你的核心竞争力，也是你在求职中最应该展示的能力标签。</p>
        </div>
        <div class="report-block">
          <h3>🔥 内在驱动引擎</h3>
          <div class="report-tags">${topInterest.map(a => `<span class="report-tag interest">${a.name}</span>`).join('')}</div>
          <p>最能驱动你的是<strong>${topInterest.map(a=>a.name).join('、')}</strong>。选择能持续激活这些驱动力的工作方向，是长期职业满意度的保障。</p>
        </div>
      </div>

      <div class="report-block">
        <h3>💎 核心价值观排序</h3>
        <div class="values-bar">
          ${topValues.map((v, i) => `
            <div class="value-bar-item">
              <span class="vbi-rank">#${i+1}</span>
              <span class="vbi-name">${v.name}</span>
              <div class="vbi-bar"><div class="vbi-fill" style="width:${100-i*15}%"></div></div>
            </div>
          `).join('')}
        </div>
      </div>

      ${criticalConstraints.length > 0 ? `
      <div class="report-block report-warning">
        <h3>🚫 核心约束与红线</h3>
        <p>你的核心约束条件是：<strong>${criticalConstraints.join('、')}</strong></p>
        <p>这些约束条件将直接影响你的职业选择范围。请在设定目标时严格遵守这些边界。</p>
      </div>` : ''}

      <div class="report-block">
        <h3>🎯 12个月目标</h3>
        <p><strong>主目标：</strong>${escapeHTML(data.primaryGoal || '未设定')}</p>
        <p><strong>副目标：</strong>${escapeHTML(data.secondaryGoal || '未设定')}</p>
      </div>

      ${data.weaknesses?.length > 0 ? `
      <div class="report-block">
        <h3>⚠️ 三大能力短板</h3>
        <ol>${data.weaknesses.filter(Boolean).map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ol>
      </div>` : ''}

      <div class="report-block report-next-step">
        <h3>➡️ 下一步</h3>
        <p>带着这份定位报告，进入<strong>模块2：职业路线</strong>，基于你的定位结果设计3条可选路径和90天冲刺计划。</p>
      </div>
    </div>
  `;
  report.scrollIntoView({ behavior: 'smooth' });
}

function collectPositioningData() {
  const data = { ability: {}, interest: {}, values: {}, constraints: {}, assets: {}, primaryGoal: '', secondaryGoal: '', weaknesses: [], redLines: {} };
  ['ability','interest','values','constraints'].forEach(key => {
    const dims = CAREER_POSITIONING.fourQuadrants[key].dimensions;
    dims.forEach(d => {
      const val = parseInt(document.getElementById(`slider-${key}-${d.id}`)?.value || 0);
      if (val > 0) data[key][d.id] = val;
    });
  });
  data.primaryGoal = document.getElementById('goal-primary')?.value || '';
  data.secondaryGoal = document.getElementById('goal-secondary')?.value || '';
  for (let i = 0; i < 3; i++) {
    const w = document.getElementById(`risk-weak-${i}`)?.value;
    if (w) data.weaknesses.push(w);
  }
  return data;
}

function getTop(obj, n, dims) {
  if (!obj) return [];
  return Object.entries(obj)
    .filter(([_, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => dims.find(d => d.id === id))
    .filter(Boolean);
}

function savePositioningData() {
  AppState.userData.positioning = collectPositioningData();
  saveState();
}

function restorePositioningData() {
  const d = AppState.userData.positioning;
  if (!d) return;
  ['ability','interest','values','constraints'].forEach(key => {
    if (d[key]) {
      Object.entries(d[key]).forEach(([id, val]) => {
        const slider = document.getElementById(`slider-${key}-${id}`);
        if (slider) { slider.value = val; updateScore(key, id); }
      });
    }
  });
  if (d.primaryGoal) { const el = document.getElementById('goal-primary'); if (el) el.value = d.primaryGoal; }
  if (d.secondaryGoal) { const el = document.getElementById('goal-secondary'); if (el) el.value = d.secondaryGoal; }
  if (d.weaknesses) {
    d.weaknesses.forEach((w, i) => {
      const el = document.getElementById(`risk-weak-${i}`);
      if (el && w) el.value = w;
    });
  }
}

// ============================================================
// 模块2：职业路线
// ============================================================
function initRoadmap() {
  renderIndustryMatch();
  renderPathComparison();
  renderSprint90();
  renderTimeBudget();
}

function renderIndustryMatch() {
  const container = document.getElementById('rm-industry-match');
  const saved = AppState.userData.roadmap || {};
  container.innerHTML = `
    <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center">
      <select id="rm-industry" class="goal-select" style="flex:1; min-width:180px" onchange="onIndustryChange()">
        <option value="">--选择行业赛道--</option>
        ${Object.keys(INDUSTRY_DATA).map(ind => `<option value="${ind}" ${saved.industry === ind ? 'selected' : ''}>${ind}</option>`).join('')}
      </select>
      <select id="rm-position" class="goal-select" style="flex:1; min-width:180px" onchange="onPositionChange()">
        <option value="">--选择目标岗位方向--</option>
        ${Object.keys(POSITION_FRAMEWORK).map(p => `<option value="${p}" ${saved.position === p ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
    </div>
    <div id="rm-match-result" style="margin-top:16px"></div>
  `;
  // 如果已有保存的选择，自动渲染
  if (saved.industry || saved.position) {
    renderMatchResult(saved.industry, saved.position);
  }
}

function onIndustryChange() {
  const ind = document.getElementById('rm-industry')?.value;
  AppState.userData.roadmap = AppState.userData.roadmap || {};
  AppState.userData.roadmap.industry = ind;
  saveState();
  renderMatchResult(ind, AppState.userData.roadmap?.position);
}

function onPositionChange() {
  const pos = document.getElementById('rm-position')?.value;
  AppState.userData.roadmap = AppState.userData.roadmap || {};
  AppState.userData.roadmap.position = pos;
  saveState();
  renderMatchResult(AppState.userData.roadmap?.industry, pos);
}

function renderMatchResult(industry, position) {
  const result = document.getElementById('rm-match-result');
  if (!industry && !position) { result.innerHTML = ''; return; }

  let html = '';
  if (industry && INDUSTRY_DATA[industry]) {
    const ind = INDUSTRY_DATA[industry];
    html += `<div class="report-block"><h4>📊 ${industry}行业概览</h4>
      <p><strong>趋势：</strong>${ind.trend}</p>
      <p><strong>细分赛道：</strong>${ind.subSectors.join(' / ')}</p>
      <p><strong>薪酬基准：</strong>${Object.entries(ind.salaryBenchmark).map(([k,v]) => k+': '+v).join(' | ')}</p></div>`;
  }
  if (position && POSITION_FRAMEWORK[position]) {
    const pos = POSITION_FRAMEWORK[position];
    html += `<div class="report-block"><h4>📋 ${position}能力模型</h4>
      <p>${pos.description}</p>
      <table class="data-table" style="margin-top:8px"><thead><tr><th>能力</th><th>权重</th><th>L1入门</th><th>L3胜任</th><th>L5专家</th></tr></thead><tbody>
      ${pos.competencies.map(c => `<tr>
        <td><strong>${c.name}</strong></td><td>${c.weight}%</td>
        <td>${c.levelDesc['1']}</td><td>${c.levelDesc['3']}</td><td>${c.levelDesc['5']}</td>
      </tr>`).join('')}
      </tbody></table>
      <p style="margin-top:12px"><strong>职级薪酬：</strong>${Object.entries(pos.levels).map(([k,v]) => k+': '+v.salary+' ('+v.scope+')').join(' | ')}</p></div>`;
  }
  result.innerHTML = html;
}

function renderPathComparison() {
  const container = document.getElementById('rm-path-comparison');
  container.innerHTML = CAREER_ROADMAP.pathComparison.map(p => `
    <div class="path-card" id="path-${p.id}">
      <div class="path-card-top">
        <span class="path-badge ${p.id}">${p.name}</span>
        <span class="path-risk risk-${p.risk === '低' ? 'low' : p.risk === '中' ? 'mid' : 'high'}">风险: ${p.risk}</span>
        <button class="btn btn-sm btn-primary" onclick="selectPath('${p.id}')">选这条路</button>
      </div>
      <p class="path-subtitle">${p.subtitle}</p>
      <div class="path-meta-row">
        <span>👤 ${p.suitable}</span>
        <span>⏱ ${p.timeline}</span>
        <span>📈 成功率 ${p.successRate}</span>
      </div>
      <div class="path-details">
        <div class="path-moves">
          <h5>关键动作</h5>
          <ol>${p.keyMoves.map(m => `<li>${m}</li>`).join('')}</ol>
        </div>
        <div class="path-pros-cons">
          <div class="pros"><h5>✅ 优势</h5><ul>${p.pros.map(pr => `<li>${pr}</li>`).join('')}</ul></div>
          <div class="cons"><h5>⚠️ 风险</h5><ul>${p.cons.map(c => `<li>${c}</li>`).join('')}</ul></div>
        </div>
      </div>
    </div>
  `).join('');
}

function selectPath(pathId) {
  document.querySelectorAll('.path-card').forEach(c => c.classList.remove('selected'));
  document.getElementById(`path-${pathId}`)?.classList.add('selected');
  AppState.userData.roadmap = AppState.userData.roadmap || {};
  AppState.userData.roadmap.selectedPath = pathId;
  saveState();
  showToast(`已选择 ${CAREER_ROADMAP.pathComparison.find(p=>p.id===pathId)?.name || pathId}`);
}

function renderSprint90() {
  const sprint = CAREER_ROADMAP.sprint90;
  const container = document.getElementById('rm-sprint');
  container.innerHTML = `
    <h3>⚡ 90天冲刺计划</h3>
    <p class="section-note">按三个阶段执行：打底→拉升→收割。每阶段有明确的里程碑和交付物。</p>
    ${sprint.phases.map(phase => `
      <div class="sprint-phase">
        <div class="sprint-phase-header">
          <h4>${phase.name}</h4>
          <span class="sprint-goal">🎯 ${phase.goal}</span>
          <span class="sprint-hours">⏱ ${phase.weeklyHours}</span>
        </div>
        <div class="sprint-milestones">
          ${phase.milestones.map(ms => `
            <div class="sprint-ms">
              <div class="sms-week">第${ms.week}周</div>
              <div class="sms-task">${ms.task}</div>
              <div class="sms-deliverable">📦 ${ms.deliverable}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('')}
  `;
}

function renderTimeBudget() {
  const container = document.getElementById('rm-time-budget');
  const tb = CAREER_ROADMAP.sprint90.weeklyTimeBudget;
  container.innerHTML = `
    <h3>⏰ ${tb.label}</h3>
    <table class="data-table">
      <thead><tr><th>活动</th><th>建议时间</th><th>频率</th></tr></thead>
      <tbody>
        ${tb.template.map(t => `<tr><td>${t.activity}</td><td>${t.hours}</td><td>${t.frequency}</td></tr>`).join('')}
      </tbody>
    </table>
    <p class="section-note">总计约10-17小时/周。如果全职找工作，40小时/周很合理；如果在职准备，需要高效利用早晚+周末时间。</p>
  `;
}

// ============================================================
// 模块3：职业能力 — 四大模板工具箱
// ============================================================
function initToolkit() {
  renderToolkitTabs();
}

function renderToolkitTabs() {
  const container = document.getElementById('toolkit-container');
  const tk = CAREER_TOOLKIT;
  container.innerHTML = `
    <div class="toolkit-tabs">
      <button class="tk-tab active" onclick="switchToolkitTab('review')">📝 复盘模板</button>
      <button class="tk-tab" onclick="switchToolkitTab('jobsearch')">📄 求职模板</button>
      <button class="tk-tab" onclick="switchToolkitTab('comm')">💬 沟通模板</button>
      <button class="tk-tab" onclick="switchToolkitTab('decision')">🧮 决策模板</button>
    </div>
    <div id="toolkit-tab-content"></div>
  `;
  switchToolkitTab('review');
}

function switchToolkitTab(tab) {
  document.querySelectorAll('.tk-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tk-tab[onclick*="${tab}"]`)?.classList.add('active');
  const content = document.getElementById('toolkit-tab-content');
  const tk = CAREER_TOOLKIT;

  if (tab === 'review') {
    content.innerHTML = Object.entries(tk.reviewTemplates).map(([key, tmpl]) => `
      <div class="toolkit-template-card">
        <div class="ttc-header" onclick="this.parentElement.classList.toggle('expanded')">
          <h4>${tmpl.name}</h4>
          <span class="expand-icon">▼</span>
        </div>
        <div class="ttc-body">
          ${tmpl.structure.map(s => `
            <div class="tt-step">
              <strong>${s.step}</strong>
              <ul>${s.fields.map(f => `<li><input type="text" class="tt-input" placeholder="${f}" onchange="saveToolkitData('${key}','${s.step}','${f}',this.value)"></li>`).join('')}</ul>
            </div>
          `).join('')}
          <button class="btn btn-sm btn-primary" onclick="exportTemplate('${key}','${tmpl.name}')">📤 导出此模板</button>
        </div>
      </div>
    `).join('');
  } else if (tab === 'jobsearch') {
    content.innerHTML = Object.entries(tk.jobSearchTemplates).map(([key, tmpl]) => `
      <div class="toolkit-template-card">
        <div class="ttc-header" onclick="this.parentElement.classList.toggle('expanded')">
          <h4>${tmpl.name}</h4>
          <span class="expand-icon">▼</span>
        </div>
        <div class="ttc-body">
          ${key === 'resumeModular' ? tmpl.modules.map(m => `
            <div class="tt-resume-module">
              <strong>${m.name}</strong>
              <p>${m.content}</p>
              <textarea class="tt-textarea" placeholder="在此填写你的${m.name}内容..." rows="3" onchange="saveToolkitData('resumeModular','${m.name}','content',this.value)"></textarea>
            </div>
          `).join('') : key === 'portfolioStructure' ? `
            <ol>${tmpl.structure.map(s => `<li>${s}</li>`).join('')}</ol>
            <textarea class="tt-textarea" placeholder="在此规划你的作品集..." rows="5"></textarea>
          ` : tmpl.structure.map(s => `
            <div class="tt-step">
              <strong>${s.step}</strong>
              <ul>${s.fields.map(f => `<li>${f}<input type="text" class="tt-input" placeholder="填写..."></li>`).join('')}</ul>
            </div>
          `).join('')}
          <button class="btn btn-sm btn-primary" onclick="exportTemplate('${key}','${tmpl.name}')">📤 导出</button>
        </div>
      </div>
    `).join('');
  } else if (tab === 'comm') {
    content.innerHTML = Object.entries(tk.communicationTemplates).map(([key, tmpl]) => `
      <div class="toolkit-template-card">
        <div class="ttc-header" onclick="this.parentElement.classList.toggle('expanded')">
          <h4>${tmpl.name}</h4>
          <span class="expand-icon">▼</span>
        </div>
        <div class="ttc-body">
          ${key === 'reverseInterview' ? tmpl.questions.map(cat => `
            <div class="tt-step">
              <strong>${cat.category}</strong>
              <ul>${cat.questions.map(q => `<li>${q}</li>`).join('')}</ul>
            </div>
          `).join('') : key === 'reportingFramework' ? tmpl.scenarios.map(s => `
            <div class="tt-scenario">
              <strong>${s.scenario}</strong>
              <p>${s.structure}</p>
            </div>
          `).join('') : tmpl.scenarios.map(s => `
            <div class="tt-scenario">
              <strong>${s.scenario}</strong>
              <div class="tt-framework">${s.framework || s.script || ''}</div>
            </div>
          `).join('')}
          <button class="btn btn-sm btn-primary" onclick="copyTemplateContent(this)">📋 复制话术</button>
        </div>
      </div>
    `).join('');
  } else if (tab === 'decision') {
    content.innerHTML = Object.entries(tk.decisionTemplates).map(([key, tmpl]) => `
      <div class="toolkit-template-card">
        <div class="ttc-header" onclick="this.parentElement.classList.toggle('expanded')">
          <h4>${tmpl.name}</h4>
          <span class="expand-icon">▼</span>
        </div>
        <div class="ttc-body">
          ${key === 'opportunityMatrix' ? `
            <table class="data-table">
              <thead><tr><th>维度</th><th>权重</th><th>当前(分)</th><th>Offer(分)</th><th>说明</th></tr></thead>
              <tbody>${tmpl.dimensions.map(d => `
                <tr><td>${d.name}</td><td>${d.weight}%</td><td><input type="number" class="tt-num" min="1" max="10" style="width:60px"></td><td><input type="number" class="tt-num" min="1" max="10" style="width:60px"></td><td>${d.desc}</td></tr>
              `).join('')}</tbody>
            </table>
            <button class="btn btn-sm btn-primary" onclick="calcOpportunityScore()">🧮 计算加权得分</button>
            <div id="opp-score-result"></div>
          ` : key === 'cityFamilyMatrix' ? `
            <ul>${tmpl.dimensions.map(d => `<li><strong>${d}：</strong><input type="text" class="tt-input" placeholder="评估..."></li>`).join('')}</ul>
          ` : `
            <ul>${tmpl.fields.map(f => `<li><strong>${f}：</strong><input type="text" class="tt-input" placeholder="填写..."></li>`).join('')}</ul>
          `}
          <button class="btn btn-sm btn-primary" onclick="exportTemplate('${key}','${tmpl.name}')">📤 导出</button>
        </div>
      </div>
    `).join('');
  }
}

function calcOpportunityScore() {
  const nums = document.querySelectorAll('.tt-num');
  const dims = CAREER_TOOLKIT.decisionTemplates.opportunityMatrix.dimensions;
  let currentTotal = 0, offerTotal = 0;
  dims.forEach((d, i) => {
    const cur = parseInt(nums[i*2]?.value || 0);
    const off = parseInt(nums[i*2+1]?.value || 0);
    currentTotal += cur * d.weight / 100;
    offerTotal += off * d.weight / 100;
  });
  document.getElementById('opp-score-result').innerHTML = `
    <div class="score-compare">
      <div><strong>当前：</strong>${currentTotal.toFixed(1)}/10</div>
      <div><strong>Offer：</strong>${offerTotal.toFixed(1)}/10</div>
      <div class="score-verdict">${offerTotal > currentTotal ? '✅ Offer优于当前' : offerTotal === currentTotal ? '🟡 相当' : '⚠️ Offer不如当前'}</div>
    </div>
  `;
}

function saveToolkitData(key, step, field, value) {
  AppState.userData.toolkit = AppState.userData.toolkit || {};
  AppState.userData.toolkit[key] = AppState.userData.toolkit[key] || {};
  AppState.userData.toolkit[key][`${step}|${field}`] = value;
  saveState();
}

function copyTemplateContent(btn) {
  const card = btn.closest('.toolkit-template-card');
  const text = card?.innerText || '';
  navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板 ✅'));
}

function exportTemplate(key, name) {
  const content = document.getElementById('toolkit-tab-content')?.innerText || '';
  const blob = new Blob([`# ${name}\n\n${content}`], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.md`;
  a.click();
}

// ============================================================
// 模块4：职业实战
// ============================================================
function initCombat() {
  renderSkillTraining();
  renderMockInterview();
  renderPracticalTasks();
  renderCaseLibrary();
  renderCombatResume(); // 整合简历优化
}

function renderSkillTraining() {
  const container = document.getElementById('combat-skills');
  container.innerHTML = Object.entries(CAREER_COMBAT.skillTraining).map(([key, skill]) => `
    <div class="combat-card">
      <h4>🏋️ ${skill.name}</h4>
      ${skill.modules.map(m => `
        <div class="skill-module">
          <strong>${m.skill}</strong>
          <ul>${m.exercises.map(e => `<li>${e}</li>`).join('')}</ul>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function renderMockInterview() {
  const container = document.getElementById('combat-interview');
  const mi = CAREER_COMBAT.mockInterview;
  container.innerHTML = `
    <div class="combat-card">
      <h4>🎙️ 模拟面试训练模式</h4>
      ${mi.modes.map(m => `<div class="interview-mode"><strong>${m.name}：</strong>${m.desc}</div>`).join('')}
    </div>
    <div class="combat-card">
      <h4>📋 高频面试题库</h4>
      <div class="qb-sections">
        <div class="qb-section">
          <h5>通用面试题</h5>
          ${mi.questionBank.general.map(q => `
            <div class="qb-item" onclick="this.classList.toggle('expanded')">
              <div class="qb-q">❓ ${q.q}</div>
              <div class="qb-hint" style="display:none">💡 ${q.hint}</div>
            </div>
          `).join('')}
        </div>
        ${Object.entries(mi.questionBank.professional).map(([name, qs]) => `
          <div class="qb-section">
            <h5>${name}方向</h5>
            ${qs.map(q => `
              <div class="qb-item" onclick="this.classList.toggle('expanded')">
                <div class="qb-q">❓ ${q.q}</div>
                <div class="qb-hint" style="display:none">💡 ${q.hint}</div>
              </div>
            `).join('')}
          </div>
        `).join('')}
        <div class="qb-section">
          <h5>压力面试题</h5>
          ${mi.questionBank.pressure.map(q => `
            <div class="qb-item" onclick="this.classList.toggle('expanded')">
              <div class="qb-q">❓ ${q.q}</div>
              <div class="qb-hint" style="display:none">💡 ${q.hint}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderPracticalTasks() {
  const container = document.getElementById('combat-tasks');
  container.innerHTML = CAREER_COMBAT.practicalTasks.categories.map(cat => `
    <div class="combat-card">
      <h4>📋 ${cat.name}</h4>
      <ul>${cat.tasks.map(t => `<li>${t}</li>`).join('')}</ul>
    </div>
  `).join('');
}

function renderCaseLibrary() {
  const container = document.getElementById('combat-cases');
  container.innerHTML = CAREER_COMBAT.caseLibrary.cases.map(c => `
    <div class="combat-card case-card">
      <h4>📖 ${c.title}</h4>
      <div class="case-detail"><strong>背景：</strong>${c.background}</div>
      <div class="case-detail"><strong>挑战：</strong>${c.challenge}</div>
      <div class="case-detail"><strong>方法：</strong>${c.approach}</div>
      <div class="case-detail"><strong>结果：</strong>${c.result}</div>
      <div class="case-lessons">
        <strong>💡 关键教训：</strong>
        <ul>${c.lessons.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>
    </div>
  `).join('');
}

function renderCombatResume() {
  const container = document.getElementById('combat-resume');
  container.innerHTML = `
    <div class="combat-card">
      <h4>📝 简历优化工作台</h4>
      <p class="section-note">粘贴你的简历，选择目标岗位方向，AI从7个维度给出评分和改进建议。</p>
      <textarea id="combat-resume-text" class="resume-textarea" placeholder="在此粘贴你的简历全文...">${AppState.userData.combat?.resumeText || ''}</textarea>
      <div class="resume-meta-row">
        <select id="combat-resume-position">
          <option value="">--目标岗位--</option>
          ${Object.keys(POSITION_FRAMEWORK).map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
        <select id="combat-resume-level">
          <option value="经理">经理</option><option value="高级经理">高级经理</option><option value="总监">总监</option>
        </select>
      </div>
      <button class="btn btn-primary" onclick="analyzeCombatResume()">🔍 7维分析</button>
      <div id="combat-resume-result" style="display:none;"></div>
    </div>
  `;
}

function analyzeCombatResume() {
  const text = document.getElementById('combat-resume-text')?.value.trim();
  if (!text || text.length < 100) { alert('请粘贴至少100字的简历内容'); return; }

  // 保存
  AppState.userData.combat = AppState.userData.combat || {};
  AppState.userData.combat.resumeText = text;
  saveState();

  const dims = ['结构清晰度','内容量化度','成就导向性','定位精准度','语言表达力','专业规范性','差异化竞争力'];
  const scores = {};
  const feedback = [];

  // 量化数据检测
  const numMatches = text.match(/\d+[%％亿万千元倍个家项次人]|\d+\.?\d*%/g) || [];
  scores['内容量化度'] = Math.min(5, Math.ceil(numMatches.length / 3));

  // 成就vs职责
  const dutyCount = (text.match(/负责|参与|协助|配合|跟进/g) || []).length;
  const achieveCount = (text.match(/完成|实现|达成|提升|增长|降低|突破|创造|打造|主导|建立/g) || []).length;
  scores['成就导向性'] = Math.min(5, Math.ceil((achieveCount / Math.max(1, dutyCount)) * 3));

  // 结构检测
  const hasSections = (text.includes('经历')||text.includes('经验')||text.includes('工作')) && (text.includes('教育')||text.includes('学历')||text.includes('学校'));
  scores['结构清晰度'] = hasSections ? 4 : 2;

  // 空话检测
  const buzzCount = ['责任心强','吃苦耐劳','认真负责','善于沟通','团队合作','积极主动','学习能力强'].filter(w => text.includes(w)).length;
  scores['语言表达力'] = Math.max(1, 5 - buzzCount);

  // 联系方式
  scores['专业规范性'] = /\d{11}|@/.test(text) ? 4 : 2;

  // 定位
  const targetPos = document.getElementById('combat-resume-position')?.value;
  if (targetPos && POSITION_FRAMEWORK[targetPos]) {
    const matches = POSITION_FRAMEWORK[targetPos].competencies.filter(c => text.includes(c.name)).length;
    scores['定位精准度'] = Math.min(5, Math.ceil(matches / 2));
  } else {
    scores['定位精准度'] = 2;
  }
  scores['差异化竞争力'] = Math.min(5, Math.ceil((scores['内容量化度'] + scores['成就导向性']) / 2));

  const totalScore = dims.reduce((sum, d) => sum + (scores[d] || 3) * (d === '内容量化度' || d === '成就导向性' ? 20 : d === '结构清晰度' || d === '定位精准度' ? 15 : 10) / 100, 0);

  const result = document.getElementById('combat-resume-result');
  result.style.display = 'block';
  result.innerHTML = `
    <div class="report-card">
      <h4>📊 简历7维分析</h4>
      <div class="score-overall">综合评分：<strong>${(totalScore * 20).toFixed(0)}/100</strong></div>
      ${dims.map(d => `
        <div class="score-row">
          <span>${d}</span>
          <div class="score-bar"><div class="score-fill" style="width:${(scores[d]||3)*20}%"></div></div>
          <span>${scores[d]||3}/5</span>
        </div>
      `).join('')}
      <div class="resume-feedback">
        ${scores['内容量化度'] < 3 ? '<p>🔧 建议：补充更多量化数据（增长率、规模、排名、效率提升%）</p>' : ''}
        ${scores['成就导向性'] < 3 ? '<p>🔧 建议：把"负责XX"改为"通过XX方法实现XX结果"</p>' : ''}
        ${scores['定位精准度'] < 3 ? '<p>🔧 建议：根据目标岗位JD调整简历关键词和重点</p>' : ''}
        ${scores['语言表达力'] < 4 ? '<p>🔧 建议：去掉"责任心强""善于沟通"等空洞表述，用案例代替</p>' : ''}
      </div>
    </div>
  `;
  result.scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
// 模块5：职业复盘
// ============================================================
function initReview() {
  renderWeeklySystem();
  renderDataPanel();
  renderMonthlyStrategy();
  renderGraduation();
  renderReviewHistory();
}

function renderWeeklySystem() {
  const container = document.getElementById('review-weekly');
  const ws = CAREER_REVIEW.weeklySystem;
  container.innerHTML = `
    <div class="review-card">
      <h4>📌 ${ws.top3Tasks.rule.split('。')[0]}</h4>
      <p class="section-note">${ws.top3Tasks.format}</p>
      <div class="top3-inputs">
        <input type="text" class="top3-input" id="top3-1" placeholder="1. 本周第一件关键事（可验证的标准）">
        <input type="text" class="top3-input" id="top3-2" placeholder="2. 本周第二件关键事">
        <input type="text" class="top3-input" id="top3-3" placeholder="3. 本周第三件关键事（不超过3件！）">
      </div>

      <h4>📋 周复盘结构</h4>
      ${ws.weeklyReview.structure.map(s => `
        <div class="review-field">
          <label>${s.section}</label>
          <p class="field-prompt">${s.prompt}</p>
          <textarea class="review-textarea" rows="2" placeholder="..."></textarea>
        </div>
      `).join('')}
      <button class="btn btn-primary" onclick="saveWeeklyReview()">💾 保存本周复盘</button>
    </div>
    <div class="review-card">
      <h4>📦 每周必交付</h4>
      <p><strong>规则：</strong>${ws.weeklyDeliverables.rule}</p>
      ${ws.weeklyDeliverables.items.map(i => `<div class="deliverable-item"><strong>${i.name}：</strong>${i.desc}</div>`).join('')}
    </div>
  `;
}

function saveWeeklyReview() {
  const top3 = [
    document.getElementById('top3-1')?.value || '',
    document.getElementById('top3-2')?.value || '',
    document.getElementById('top3-3')?.value || ''
  ].filter(Boolean);
  const answers = [];
  document.querySelectorAll('#review-weekly .review-textarea').forEach((ta, i) => {
    if (ta.value.trim()) answers.push({ section: CAREER_REVIEW.weeklySystem.weeklyReview.structure[i]?.section, answer: ta.value.trim() });
  });

  AppState.userData.reviews = AppState.userData.reviews || [];
  AppState.userData.reviews.push({ date: new Date().toISOString(), top3, answers, type: 'weekly' });
  saveState();
  showToast('✅ 周复盘已保存！');
  renderReviewHistory();
}

function renderDataPanel() {
  const container = document.getElementById('review-data');
  const dp = CAREER_REVIEW.dataPanel;
  container.innerHTML = `
    <div class="data-panel-grid">
      <div class="dp-section">
        <h4>📊 ${dp.funnelMetrics.label}</h4>
        ${dp.funnelMetrics.map(m => `
          <div class="dp-metric">
            <span>${m.name}</span>
            <span class="dp-target">目标: ${m.target}</span>
            <input type="number" class="dp-input" id="metric-${m.id}" placeholder="${m.unit}" onchange="saveMetrics()">
          </div>
        `).join('')}
      </div>
      <div class="dp-section">
        <h4>📈 ${dp.behaviorMetrics.label}</h4>
        ${dp.behaviorMetrics.map(m => `
          <div class="dp-metric">
            <span>${m.name}</span>
            <span class="dp-target">目标: ${m.target}</span>
            <input type="number" class="dp-input" id="bmetric-${m.id}" placeholder="数值" onchange="saveMetrics()">
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function saveMetrics() {
  const metrics = {};
  document.querySelectorAll('.dp-input').forEach(input => {
    if (input.value) metrics[input.id] = parseFloat(input.value);
  });
  AppState.userData.metrics = AppState.userData.metrics || {};
  AppState.userData.metrics[new Date().toISOString().slice(0,7)] = metrics;
  saveState();
}

function renderMonthlyStrategy() {
  const container = document.getElementById('review-monthly');
  const ms = CAREER_REVIEW.monthlyStrategy;
  container.innerHTML = `
    <h4>🔄 月度策略复盘</h4>
    ${ms.reviewQuestions.map((q, i) => `
      <div class="review-field">
        <label>${q}</label>
        <textarea class="review-textarea" rows="2" placeholder="你的回答..."></textarea>
      </div>
    `).join('')}
    <h5>决策选项：</h5>
    <div class="decision-options">
      ${ms.decisionOptions.map(d => `
        <div class="decision-option">
          <strong>${d.option}：</strong>${d.condition}
        </div>
      `).join('')}
    </div>
    <button class="btn btn-primary" onclick="saveMonthlyReview()">💾 保存月度复盘</button>
  `;
}

function saveMonthlyReview() {
  const answers = [];
  document.querySelectorAll('#review-monthly .review-textarea').forEach((ta, i) => {
    if (ta.value.trim()) answers.push({ q: CAREER_REVIEW.monthlyStrategy.reviewQuestions[i], a: ta.value.trim() });
  });
  AppState.userData.reviews = AppState.userData.reviews || [];
  AppState.userData.reviews.push({ date: new Date().toISOString(), answers, type: 'monthly' });
  saveState();
  showToast('✅ 月度复盘已保存！');
}

function renderGraduation() {
  const container = document.getElementById('review-graduation');
  const gc = CAREER_REVIEW.graduationCriteria;
  container.innerHTML = `
    <h4>🎓 毕业标准</h4>
    <p class="section-note">${gc.description}</p>
    ${gc.criteria.map(c => `<div class="grad-criterion"><strong>${c.weight}：</strong>${c.standard}</div>`).join('')}
    <div class="grad-ceremony">
      <h5>毕业仪式：</h5>
      <ol>${gc.graduationCeremony.map(g => `<li>${g}</li>`).join('')}</ol>
    </div>
  `;
}

function renderReviewHistory() {
  const container = document.getElementById('review-history-list');
  const reviews = AppState.userData.reviews || [];
  if (reviews.length === 0) {
    container.innerHTML = '<p class="text-muted">暂无复盘记录。完成第一次周复盘后，这里会显示你的成长轨迹。</p>';
    return;
  }
  container.innerHTML = reviews.slice().reverse().slice(0, 10).map((r, i) => `
    <div class="history-card">
      <div class="hist-date">📅 ${new Date(r.date).toLocaleDateString('zh-CN')} · ${r.type === 'weekly' ? '周复盘' : '月度复盘'}</div>
      ${r.top3 ? `<div class="hist-top3">本周三件事：${r.top3.map(t => '✓ '+escapeHTML(t)).join(' / ')}</div>` : ''}
      ${r.answers ? `<div class="hist-summary">回答了${r.answers.length}个复盘问题</div>` : ''}
    </div>
  `).join('');
}

// ============================================================
// 模块6：入职陪跑
// ============================================================
function initOnboarding() {
  render90DayPlan();
  renderUpwardManagement();
  renderDownwardManagement();
  renderCrossFunctional();
  renderStopLoss();
}

function render90DayPlan() {
  const container = document.getElementById('ob-90day');
  container.innerHTML = ONBOARDING_COMPANION.ninetyDayPlan.phases.map(phase => `
    <div class="ob-phase">
      <div class="ob-phase-header">
        <h3>${phase.name}</h3>
        <p class="ob-goal">🎯 ${phase.goal}</p>
      </div>
      <div class="ob-weeks">
        ${phase.weeks.map(w => `
          <div class="ob-week">
            <div class="ob-week-header">第${w.week}周：${w.focus}</div>
            <ul>${w.tasks.map(t => `<li>${t}</li>`).join('')}</ul>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function renderUpwardManagement() {
  const container = document.getElementById('ob-upward');
  const um = ONBOARDING_COMPANION.upwardManagement;
  container.innerHTML = `
    <h3>${um.title}</h3>
    <div class="ob-principles">
      <h4>核心理念</h4>
      <ul>${um.principles.map(p => `<li>${p}</li>`).join('')}</ul>
    </div>
    <div class="ob-rhythm">
      <h4>周度沟通节奏</h4>
      ${um.weeklyRhythm.map(r => `
        <div class="rhythm-item"><strong>${r.action}</strong><br>${r.method}</div>
      `).join('')}
    </div>
    <div class="ob-expectation">
      <h4>${um.expectationAlignment.title}</h4>
      <ul>${um.expectationAlignment.items.map(i => `<li>${i}</li>`).join('')}</ul>
    </div>
  `;
}

function renderDownwardManagement() {
  const container = document.getElementById('ob-downward');
  const dm = ONBOARDING_COMPANION.downwardManagement;
  container.innerHTML = `
    <h3>${dm.title}</h3>
    <div class="ob-section">
      <h4>${dm.first30Days.title}</h4>
      <ul>${dm.first30Days.actions.map(a => `<li>${a}</li>`).join('')}</ul>
    </div>
    <div class="ob-section">
      <h4>${dm.oneOnOneFramework.title}</h4>
      ${dm.oneOnOneFramework.structure.map(s => `<div class="one-on-one-step">${s}</div>`).join('')}
    </div>
    <div class="ob-section">
      <h4>${dm.delegationMatrix.title}</h4>
      <ul>${dm.delegationMatrix.principles.map(p => `<li>${p}</li>`).join('')}</ul>
    </div>
  `;
}

function renderCrossFunctional() {
  const container = document.getElementById('ob-cross');
  const cf = ONBOARDING_COMPANION.crossFunctional;
  container.innerHTML = `
    <h3>${cf.title}</h3>
    <div class="ob-section">
      <h4>${cf.stakeholderMapping.description}</h4>
      ${cf.stakeholderMapping.categories.map(c => `
        <div class="stakeholder-type"><strong>${c.type}：</strong>${c.desc}<br><em>💡 ${c.action}</em></div>
      `).join('')}
    </div>
    <div class="ob-section">
      <h4>${cf.allianceBuilding.title}</h4>
      <ol>${cf.allianceBuilding.steps.map(s => `<li>${s}</li>`).join('')}</ol>
    </div>
  `;
}

function renderStopLoss() {
  const container = document.getElementById('ob-stoploss');
  const sl = ONBOARDING_COMPANION.stopLossFramework;
  container.innerHTML = `
    <h3>⚠️ ${sl.title}</h3>
    ${sl.criteria.map(c => `
      <div class="stoploss-item">
        <div class="sl-signal">🚩 ${c.signal}</div>
        <div class="sl-action">➡️ ${c.action}</div>
      </div>
    `).join('')}
    <div class="ob-section" style="margin-top:20px">
      <h4>🎯 ${sl.probationStrategy.title}</h4>
      <ul>${sl.probationStrategy.checklist.map(c => `<li>${c}</li>`).join('')}</ul>
    </div>
  `;
}

// ============================================================
// 通用
// ============================================================
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  // 尝试自动登录：检查上次激活码是否还有效
  var lastCode = localStorage.getItem('last_activation_code');
  if (lastCode) {
    var storageKey = 'activation_' + simpleHash(lastCode.replace(/[-\s]/g, '').toUpperCase()).toString(16);
    var cached = localStorage.getItem(storageKey);
    if (cached) {
      var validation = JSON.parse(cached);
      var fresh = validateCode(lastCode);
      if (fresh.valid) {
        validation.maxUses = fresh.maxUses;
        validation.expiry = fresh.expiry;
        validation.maxWechatUsers = fresh.maxWechatUsers;
      }
      if (new Date() <= new Date(validation.expiry + 'T23:59:59')) {
        var usage = getUsage(lastCode);
        if (validation.maxUses === 0 || usage.uses < validation.maxUses) {
          // 自动登录
          currentSession = { code: lastCode, userName: validation.userName, expiry: validation.expiry, maxUses: validation.maxUses, maxWechatUsers: validation.maxWechatUsers, storageKey: storageKey };
          enterApp();
          // 注册导航事件
          document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
              const mod = item.dataset.module;
              if (mod) navTo(mod);
            });
          });
          return;
        }
      }
    }
  }
  // 显示登录界面
  document.getElementById('loginScreen').style.display = '';
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const mod = item.dataset.module;
      if (mod) navTo(mod);
    });
  });
});
