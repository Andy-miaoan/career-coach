/**
 * AI职业陪跑系统 v2.2 — 主应用逻辑（个人档案 + 瓶颈诊断 + 6模块）
 * AI指令生成模式：填写数据 → 生成AI指令 → 复制 → 粘贴到DeepSeek/Kimi等AI工具
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

// ============================================================
// 防绕过保护层（防止 Console 直接调用 enterApp 或删除登录遮罩）
// ============================================================
const _appGuard = (function() {
  var _token = null;
  var _tokenTTL = 15000; // 15秒内有效

  // 监视登录遮罩被删除
  var _observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      for (var j = 0; j < m.removedNodes.length; j++) {
        var node = m.removedNodes[j];
        if (node.id === 'loginScreen' && !_token) {
          // 登录遮罩被未经授权删除 → 恢复并警告
          if (node.parentNode || document.body) {
            (node.parentNode || document.body).insertBefore(node, (node.parentNode || document.body).firstChild);
          }
          var toast = document.getElementById('toast');
          if (toast) { toast.textContent = '⚠️ 请通过正常激活流程使用'; toast.classList.add('show', 'warn'); setTimeout(function(){ toast.classList.remove('show','warn'); }, 3000); }
        }
      }
    }
  });
  _observer.observe(document.documentElement, { childList: true, subtree: true });

  return {
    authorize: function() { _token = Date.now(); },
    verify: function() {
      if (!_token) return false;
      if (Date.now() - _token > _tokenTTL) { _token = null; return false; }
      _token = null; // 一次性使用
      return true;
    }
  };
})();

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
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (controller) { options.signal = controller.signal; }
  var timeoutId = controller ? setTimeout(function(){ controller.abort(); }, 8000) : null;
  return fetch('https://api.github.com' + path, options)
    .then(function(r){ clearTimeout(timeoutId); return r.json(); })
    .catch(function(e){ clearTimeout(timeoutId); console.log('[ghApi] 请求失败: ' + (e && e.name === 'AbortError' ? '超时' : (e && e.message))); return null; });
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
  console.log('[saveWechat] 开始执行');
  showToast('正在处理...', false);
  try {
    var wx = document.getElementById('wechatInput').value.trim();
    var errEl = document.getElementById('wechatBindErr');
    var btn = document.querySelector('.wechat-bind-card .btn-save');
    console.log('[saveWechat] wx=' + wx + ' maxWechatUsers=' + (currentSession ? currentSession.maxWechatUsers : 'session_null') + ' GH_TOKEN=' + (GH_TOKEN ? '已设置' : '未设置'));
    if (!currentSession) {
      errEl.textContent = '会话已过期，请刷新页面重新激活';
      return;
    }
    if (!wx && currentSession.maxWechatUsers > 0) {
      errEl.textContent = '此激活码需要绑定微信号才能使用，请输入微信号';
      return;
    }
    if (wx && currentSession.maxWechatUsers > 0) {
      var bindings = getWechatBindings(currentSession.code);
      if (bindings.indexOf(wx) === -1) {
        if (bindings.length >= currentSession.maxWechatUsers) {
          errEl.textContent = '该激活码已达人数上限（最多' + currentSession.maxWechatUsers + '人）';
          return;
        }
        bindings.push(wx);
        saveWechatBindings(currentSession.code, bindings);
      }
    }
    if (wx) {
      localStorage.setItem('bound_wechat', wx);
    }
    // 始终先本地进入App，云端同步在后台进行（不阻塞用户进入）
    console.log('[saveWechat] 隐藏弹窗→授权→进入App');
    btn.disabled = true;
    document.getElementById('wechatBindOverlay').classList.remove('show');
    _appGuard.authorize();
    enterApp();
    // 云端后台同步（异步，不影响用户已进入的状态）
    if (GH_TOKEN && wx) {
      attemptBindWechat(wx, 0);
    }
  } catch(e) {
    console.log('[saveWechat] 异常：' + e.message);
    var errEl = document.getElementById('wechatBindErr');
    if (errEl) errEl.textContent = '操作失败，请刷新页面重试';
    showToast('操作失败，请刷新页面后重试', true);
  }
}

function attemptBindWechat(wx, retryCount) {
  console.log('[attemptBindWechat] 开始 retry=' + (retryCount || 0));
  var btn = document.querySelector('.wechat-bind-card .btn-save');
  getOrCreateGist().then(function(gistId) {
    console.log('[attemptBindWechat] gistId=' + (gistId || 'null'));
    if (!gistId) { console.log('[attemptBindWechat] 无gistId→fallbackLocal'); fallbackLocal(); return; }
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
      return writeSharedState(gistId, state).then(function(result) {
        if (result && result.message && result.message.indexOf('Precondition') !== -1 && retryCount < 3) {
          return attemptBindWechat(wx, retryCount + 1);
        }
        if (result && !result.id && result.message) {
          fallbackLocal();
          return;
        }
        var usage = getUsage(currentSession.code);
        usage.uses = cs.uses;
        localStorage.setItem(getUsageKey(currentSession.code), JSON.stringify(usage));
        saveWechatBindings(currentSession.code, cs.wechatIds);
        localStorage.setItem('bound_wechat', wx);
        if (document.getElementById('mainApp').style.display === 'none') {
          document.getElementById('wechatBindOverlay').classList.remove('show');
          _appGuard.authorize();
          enterApp();
        }
      });
    });
  }).catch(function(){ fallbackLocal(); });

  function fallbackLocal() {
    console.log('[fallbackLocal] 回退本地绑定');
    var bindings = getWechatBindings(currentSession.code);
    if (bindings.indexOf(wx) === -1) {
      if (bindings.length >= currentSession.maxWechatUsers) {
        failFallback('已达人数上限（最多' + currentSession.maxWechatUsers + '人）');
        return;
      }
      bindings.push(wx);
    }
    saveWechatBindings(currentSession.code, bindings);
    localStorage.setItem('bound_wechat', wx);
    if (document.getElementById('mainApp').style.display === 'none') {
      document.getElementById('wechatBindOverlay').classList.remove('show');
      _appGuard.authorize();
      enterApp();
    }
  }

  function failFallback(msg) {
    btn.textContent = '绑定，开始使用';
    btn.disabled = false;
    document.getElementById('wechatBindErr').textContent = msg;
  }
}

function skipWechat() {
  if (currentSession.maxWechatUsers > 0) {
    document.getElementById('wechatBindErr').textContent = '此激活码需要绑定微信号才能使用';
    return;
  }
  document.getElementById('wechatBindOverlay').classList.remove('show');
  _appGuard.authorize();
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
    showWechatBindPopup('该激活码限 ' + validation.maxWechatUsers + ' 人使用', true);
  } else if (boundWx && validation.maxWechatUsers > 0) {
    // 安全加固：即使本地有bound_wechat，也需通过Gist验证该微信确实被授权
    if (GH_TOKEN) {
      btn.textContent = '验证身份中...';
      getOrCreateGist().then(function(gistId) {
        if (!gistId) { fallbackEnter(); return; }
        return readSharedState(gistId).then(function(state) {
          var ch = currentSession.code.replace(/[-\s]/g, '').toUpperCase();
          var h = simpleHash(ch).toString(16);
          var cs = state.codes[h];
          if (cs && cs.wechatIds && cs.wechatIds.indexOf(boundWx) !== -1) {
            // Gist验证通过：此微信确实被授权
            saveWechatBindings(currentSession.code, cs.wechatIds);
            // 同步使用次数（以Gist为准）
            var key = getUsageKey(currentSession.code);
            var usage = getUsage(currentSession.code);
            usage.uses = cs.uses || usage.uses;
            localStorage.setItem(key, JSON.stringify(usage));
            btn.textContent = '激活成功！欢迎回来';
            _appGuard.authorize();
            setTimeout(function(){ enterApp(); }, 400);
          } else {
            // Gist验证失败：本地bound_wechat是伪造的，清除并强制重新绑定
            localStorage.removeItem('bound_wechat');
            showWechatBindPopup('该激活码限 ' + validation.maxWechatUsers + ' 人使用', true);
          }
        });
      }).catch(function(){ fallbackEnter(); });
      function fallbackEnter() {
        btn.textContent = '激活成功！欢迎回来';
        _appGuard.authorize();
        setTimeout(function(){ enterApp(); }, 400);
      }
    } else {
      // 无云端同步：提示风险但允许进入（纯本地模式无法强制验证）
      btn.textContent = '激活成功！欢迎回来（建议设置云端同步）';
      _appGuard.authorize();
      setTimeout(function(){ enterApp(); }, 400);
    }
  } else {
    showWechatBindPopup('到期前微信自动提醒续费', false);
  }

  function showWechatBindPopup(subt, required) {
    document.getElementById('wechatBindSubt').textContent = subt;
    document.getElementById('wechatBindBenefits').style.display = required ? 'none' : '';
    document.getElementById('wechatBindSkipBtn').style.display = required ? 'none' : '';
    document.getElementById('wechatInput').placeholder = required ? '请输入微信号（必填，用于身份识别）' : '输入微信号（选填）';
    document.getElementById('wechatBindErr').textContent = '';
    document.getElementById('wechatBindOverlay').classList.add('show');
    if (!required) {
      btn.disabled = false;
      btn.textContent = '激活使用';
    }
  }
}

function enterApp() {
  console.log('[enterApp] 开始 verify...');
  if (!_appGuard.verify()) {
    console.log('[enterApp] 失败：_appGuard.verify()返回false');
    showToast('会话已过期，请重新激活', true);
    document.getElementById('loginScreen').style.display = '';
    document.getElementById('activateBtn').disabled = false;
    document.getElementById('activateBtn').textContent = '激活使用';
    return;
  }
  console.log('[enterApp] verify通过');
  if (!currentSession) {
    console.log('[enterApp] 失败：currentSession为空');
    showToast('会话丢失，请重新激活', true);
    document.getElementById('loginScreen').style.display = '';
    return;
  }
  console.log('[enterApp] 隐藏登录屏→显示主界面');
  try {
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
  } catch(e) {
    console.log('[enterApp] UI操作异常：' + e.message);
    showToast('界面加载失败，请刷新页面重试', true);
    return;
  }
  if (GH_TOKEN) {
    getOrCreateGist().then(function(gistId) {
      if (!gistId) return;
      return readSharedStateWithETag(gistId).then(function(state) {
        var ch = currentSession.code.replace(/[-\s]/g, '').toUpperCase();
        var h = simpleHash(ch).toString(16);
        var cs = state.codes[h];
        if (!cs) {
          // 首次使用：初始化Gist中的激活码记录
          cs = { wechatIds: boundWx ? [boundWx] : [], uses: 0, maxUses: currentSession.maxUses, maxWechatUsers: currentSession.maxWechatUsers, expiry: currentSession.expiry, userName: currentSession.userName };
          state.codes[h] = cs;
          writeSharedState(gistId, state);
        }
        // 以Gist为权威来源同步使用次数
        var key = getUsageKey(currentSession.code);
        var usage = getUsage(currentSession.code);
        usage.uses = Math.max(usage.uses, cs.uses || 0);
        localStorage.setItem(key, JSON.stringify(usage));
        // 同步Gist中的激活码参数（管理员可能已更新）
        if (cs.maxUses) currentSession.maxUses = cs.maxUses;
        if (cs.maxWechatUsers) currentSession.maxWechatUsers = cs.maxWechatUsers;
        // 同步微信绑定列表
        saveWechatBindings(currentSession.code, cs.wechatIds || []);
        // 安全加固：如果maxWechatUsers>0但本地bound_wechat不在Gist列表中，清除伪造标记
        if (currentSession.maxWechatUsers > 0 && boundWx && cs.wechatIds && cs.wechatIds.indexOf(boundWx) === -1) {
          localStorage.removeItem('bound_wechat');
          if (wxEl) wxEl.style.display = 'none';
        }
        refreshUsageDisplay();
      });
    }).catch(function(){});
  }
  navTo('positioning');
}

function logout() {
  if (!confirm('确定要退出吗？\n\n退出后重新进入需要输入激活码。')) return;
  saveDrafts();
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
// 应用主逻辑（v2.2 — AI指令生成模式）
// ============================================================

const AppState = {
  currentModule: 'positioning',
  userData: {}
};

function loadState() {
  try {
    const s = localStorage.getItem('career_coach_v3');
    if (s) AppState.userData = JSON.parse(s);
  } catch(e) {}
}
function saveState() {
  localStorage.setItem('career_coach_v3', JSON.stringify(AppState.userData));
}

// ========== 通用工具函数 ==========
function wrapPrompt(raw, moduleName, modeName) {
  var profileCtx = getProfileContext();
  var full = profileCtx ? (profileCtx + '\n\n---\n\n' + raw) : raw;
  var history = JSON.parse(localStorage.getItem('prompt_history') || '[]');
  history.unshift({ module: moduleName, mode: modeName || '', preview: raw.substring(0, 100), date: new Date().toISOString() });
  if (history.length > 30) history = history.slice(0, 30);
  localStorage.setItem('prompt_history', JSON.stringify(history));
  return full;
}

function copyResult(boxId) {
  var box = document.getElementById(boxId);
  var text = box.textContent;
  navigator.clipboard.writeText(text).then(function(){
    showToast('✅ 已复制到剪贴板，可粘贴到 DeepSeek / Kimi / 豆包 等AI工具使用');
  }).catch(function(){
    showToast('复制失败，请手动选择复制', true);
  });
}

function showSpinner(containerId) {
  var el = document.getElementById(containerId);
  el.classList.add('show');
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#94a3b8"><div class="spinner"></div><div style="margin-top:12px">正在生成AI指令...</div></div>';
}

function navTo(mod) {
  AppState.currentModule = mod;
  document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
  document.querySelector(`.nav-item[data-module="${mod}"]`)?.classList.add('active');
  document.querySelectorAll('.module-content').forEach(e => e.classList.remove('active'));
  const target = document.getElementById(`module-${mod}`);
  if (target) target.classList.add('active');

  switch(mod) {
    case 'profile': initProfile(); break;
    case 'positioning': initPositioning(); break;
    case 'roadmap': initRoadmap(); break;
    case 'toolkit': initToolkit(); break;
    case 'combat': initCombat(); break;
    case 'review': initReview(); break;
    case 'onboarding': initOnboarding(); break;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  saveDrafts();
}

// ========== 表单草稿自动保存 ==========
function saveDrafts() {
  var drafts = {};
  document.querySelectorAll('.module-content input[type="text"], .module-content input[type="number"], .module-content textarea, .module-content select').forEach(function(el) {
    if (el.id && el.value) drafts[el.id] = el.value;
  });
  localStorage.setItem('form_drafts_v3', JSON.stringify(drafts));
}
function restoreDrafts() {
  try {
    var drafts = JSON.parse(localStorage.getItem('form_drafts_v3') || '{}');
    Object.keys(drafts).forEach(function(id) {
      var el = document.getElementById(id);
      if (el && !el.value) el.value = drafts[id];
    });
  } catch(e) {}
}

// ============================================================
// 模块0：个人档案（Profile System v1.0）
// 所有模块的AI指令将自动包含档案信息，使分析更精准
// ============================================================
function getProfileContext() {
  var p = AppState.userData.profile;
  if (!p || !p.birthYear) return '';
  var lines = [];
  lines.push('【用户个人档案（已自动填入）】');
  if (p.gender) lines.push('性别：' + p.gender);
  if (p.birthYear) lines.push('出生年份：' + p.birthYear + '年（当前年龄约' + (new Date().getFullYear() - parseInt(p.birthYear)) + '岁）');
  if (p.city) lines.push('所在城市：' + p.city);
  if (p.hukou) lines.push('户籍地：' + p.hukou);
  if (p.marital) lines.push('婚姻状况：' + p.marital);
  if (p.eduLevel) {
    var eduStr = '学历：' + p.eduLevel;
    if (p.eduSchool) eduStr += ' · ' + p.eduSchool;
    if (p.eduMajor) eduStr += ' · ' + p.eduMajor;
    if (p.eduYear) eduStr += ' · ' + p.eduYear + '年毕业';
    lines.push(eduStr);
  }
  if (p.otherEdu) lines.push('其他教育/培训：' + p.otherEdu);
  if (p.currentCompany) lines.push('当前/最近公司：' + p.currentCompany);
  if (p.currentTitle) lines.push('当前/最近岗位：' + p.currentTitle);
  if (p.companyInfo) {
    var ci = p.companyInfo;
    var ciStr = '公司基本情况：';
    var ciParts = [];
    if (ci.type) ciParts.push('性质' + ci.type);
    if (ci.scale) ciParts.push('规模' + ci.scale);
    if (ci.revenue) ciParts.push('年营收' + ci.revenue);
    if (ci.brand) ciParts.push('品牌/业务：' + ci.brand);
    if (ci.stage) ciParts.push('阶段：' + ci.stage);
    ciStr += ciParts.join('，');
    lines.push(ciStr);
  }
  if (p.reportTo) lines.push('汇报对象：' + p.reportTo);
  if (p.teamSize) lines.push('管理团队：直接下属' + p.teamSize + '人' + (p.indirectTeam ? '，间接管理' + p.indirectTeam + '人' : ''));
  if (p.salary) lines.push('当前年薪构成：' + p.salary);
  if (p.coreDuties) lines.push('核心职责：' + p.coreDuties);
  if (p.careerAchievements) lines.push('最突出的5项业绩/成就：' + p.careerAchievements);
  if (p.advantages) lines.push('职业优势：' + p.advantages);
  if (p.weaknesses) lines.push('待提升方面：' + p.weaknesses);
  if (p.targetPositions) lines.push('期望下一个岗位：' + p.targetPositions);
  if (p.targetCompanyType) lines.push('期望企业类型：' + p.targetCompanyType);
  if (p.targetCity) lines.push('期望工作城市：' + p.targetCity);
  if (p.targetSalary) lines.push('期望薪酬范围（年/税前）：' + p.targetSalary);
  if (p.careerConfusion) lines.push('当前最大职业困惑：' + p.careerConfusion);
  if (p.careerDrivers) lines.push('考虑职业变化的核心驱动因素：' + p.careerDrivers);
  if (p.careerValues) lines.push('职业价值观排序：' + p.careerValues);
  if (p.vision3year) lines.push('3年后期望：' + p.vision3year);
  if (p.vision5year) lines.push('5年后期望：' + p.vision5year);
  if (p.willingInvest) lines.push('愿意为职业发展投入的方面：' + p.willingInvest);
  if (p.constraints) lines.push('特殊限制条件：' + p.constraints);
  if (p.workHistory && p.workHistory.length > 0) {
    lines.push('完整工作经历：');
    for (var i = 0; i < p.workHistory.length; i++) {
      var wh = p.workHistory[i];
      lines.push('  [' + (i + 1) + '] ' + wh.company + ' | ' + wh.title + ' | ' + wh.period + (wh.responsibilities ? ' | 职责：' + wh.responsibilities : '') + (wh.achievements ? ' | 业绩：' + wh.achievements : '') + (wh.leaveReason ? ' | 离职原因：' + wh.leaveReason : ''));
    }
  }
  return lines.join('\n');
}

function initProfile() {
  var container = document.getElementById('profile-container');
  var p = AppState.userData.profile || {};
  var ci = p.companyInfo || {};
  var wh = p.workHistory || [];

  function w(name) { return escapeHTML(p[name] || ''); }
  function ciw(name) { return escapeHTML(ci[name] || ''); }

  var html = '';

  // Section 1: 基本信息
  html += '<div class="card"><h3>📋 基本信息</h3><p class="section-note">这些信息将自动应用到所有模块的AI分析中，让结果更精准。</p>';
  html += '<div class="form-row-2col">';
  html += '<div><label>性别</label><select id="pf-gender"><option value="">请选择</option><option value="男"' + (p.gender === '男' ? ' selected' : '') + '>男</option><option value="女"' + (p.gender === '女' ? ' selected' : '') + '>女</option></select></div>';
  html += '<div><label>出生年份</label><input type="number" id="pf-birthYear" placeholder="如：1990" value="' + w('birthYear') + '" min="1960" max="2010"></div>';
  html += '</div>';
  html += '<div class="form-row-2col">';
  html += '<div><label>目前所在城市</label><input type="text" id="pf-city" placeholder="如：上海" value="' + w('city') + '"></div>';
  html += '<div><label>户籍所在地</label><input type="text" id="pf-hukou" placeholder="如：浙江杭州" value="' + w('hukou') + '"></div>';
  html += '</div>';
  html += '<div class="form-row-2col">';
  html += '<div><label>婚姻状况</label><select id="pf-marital"><option value="">请选择</option><option value="未婚"' + (p.marital === '未婚' ? ' selected' : '') + '>未婚</option><option value="已婚未育"' + (p.marital === '已婚未育' ? ' selected' : '') + '>已婚未育</option><option value="已婚已育"' + (p.marital === '已婚已育' ? ' selected' : '') + '>已婚已育</option><option value="离异"' + (p.marital === '离异' ? ' selected' : '') + '>离异</option></select></div>';
  html += '<div><label>最高学历</label><select id="pf-eduLevel"><option value="">请选择</option><option value="大专"' + (p.eduLevel === '大专' ? ' selected' : '') + '>大专</option><option value="本科"' + (p.eduLevel === '本科' ? ' selected' : '') + '>本科</option><option value="硕士"' + (p.eduLevel === '硕士' ? ' selected' : '') + '>硕士（含MBA/EMBA）</option><option value="博士"' + (p.eduLevel === '博士' ? ' selected' : '') + '>博士</option></select></div>';
  html += '</div>';
  html += '<div class="form-row-2col">';
  html += '<div><label>毕业学校</label><input type="text" id="pf-eduSchool" placeholder="学校名称" value="' + w('eduSchool') + '"></div>';
  html += '<div><label>专业</label><input type="text" id="pf-eduMajor" placeholder="专业名称" value="' + w('eduMajor') + '"></div>';
  html += '</div>';
  html += '<div class="form-row-2col">';
  html += '<div><label>毕业年份</label><input type="text" id="pf-eduYear" placeholder="如：2015" value="' + w('eduYear') + '"></div>';
  html += '<div><label>其他教育/培训经历</label><input type="text" id="pf-otherEdu" placeholder="如：MBA、行业认证、重要培训" value="' + w('otherEdu') + '"></div>';
  html += '</div>';
  html += '</div>';

  // Section 2: 当前工作状态
  html += '<div class="card"><h3>💼 当前工作状态</h3>';
  html += '<div class="form-row-2col">';
  html += '<div><label>当前/最近公司名称</label><input type="text" id="pf-currentCompany" placeholder="公司全称" value="' + w('currentCompany') + '"></div>';
  html += '<div><label>当前/最近岗位名称及职级</label><input type="text" id="pf-currentTitle" placeholder="如：运营总监（D级）/ 商品VP" value="' + w('currentTitle') + '"></div>';
  html += '</div>';
  html += '<label>公司基本情况</label>';
  html += '<div class="form-row-2col">';
  html += '<div><input type="text" id="pf-companyType" placeholder="公司性质（国企/民营/外资/合资）" value="' + ciw('type') + '"></div>';
  html += '<div><input type="text" id="pf-companyScale" placeholder="公司规模（员工人数）" value="' + ciw('scale') + '"></div>';
  html += '</div>';
  html += '<div class="form-row-2col">';
  html += '<div><input type="text" id="pf-companyRevenue" placeholder="年营收规模（大致范围）" value="' + ciw('revenue') + '"></div>';
  html += '<div><input type="text" id="pf-companyBrand" placeholder="主要品牌/业务" value="' + ciw('brand') + '"></div>';
  html += '</div>';
  html += '<input type="text" id="pf-companyStage" placeholder="发展阶段（初创/成长/成熟/转型）" value="' + ciw('stage') + '" style="margin-top:6px">';
  html += '<div class="form-row-2col" style="margin-top:12px">';
  html += '<div><label>汇报对象</label><input type="text" id="pf-reportTo" placeholder="如：向CEO直接汇报 / 向品牌VP汇报" value="' + w('reportTo') + '"></div>';
  html += '<div><label>直接管理团队人数</label><input type="text" id="pf-teamSize" placeholder="直接下属人数" value="' + w('teamSize') + '"></div>';
  html += '</div>';
  html += '<label style="margin-top:8px">间接管理团队总人数</label>';
  html += '<input type="text" id="pf-indirectTeam" placeholder="间接管理人数" value="' + w('indirectTeam') + '">';
  html += '<label style="margin-top:8px">当前年薪构成（税前）</label>';
  html += '<textarea id="pf-salary" rows="3" placeholder="月薪、绩效奖金/年终奖范围、股权/期权、其他福利等，如：月度固定35K×12 + 绩效奖金约10万/年 + 年终奖2-4个月">' + w('salary') + '</textarea>';
  html += '<label style="margin-top:8px">核心职责（3-5项，按重要性排序）</label>';
  html += '<textarea id="pf-coreDuties" rows="4" placeholder="如：&#10;1. 全国200+门店的运营管理，负责年度GMV 8亿元目标达成&#10;2. 制定年度零售策略和营销规划&#10;3. 管理60人的区域运营团队">' + w('coreDuties') + '</textarea>';
  html += '</div>';

  // Section 3: 工作经历
  html += '<div class="card"><h3>📜 工作经历</h3><p class="section-note">按时间倒序填写，AI将基于你的完整职业轨迹进行分析。</p>';
  html += '<div id="profile-workHistory">';
  for (var j = 0; j < Math.max(wh.length, 1); j++) {
    var whItem = wh[j] || {};
    html += '<div class="wh-block" data-idx="' + j + '">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
    html += '<strong>第' + (j + 1) + '段工作经历</strong>';
    html += '<button class="btn btn-sm btn-outline" onclick="removeWorkHistory(' + j + ')" style="color:#ef4444;border-color:#ef4444;font-size:11px">删除</button>';
    html += '</div>';
    html += '<div class="form-row-2col">';
    html += '<div><label>公司名称</label><input type="text" class="wh-company" placeholder="公司名称" value="' + escapeHTML(whItem.company || '') + '"></div>';
    html += '<div><label>岗位名称及职级</label><input type="text" class="wh-title" placeholder="岗位+职级" value="' + escapeHTML(whItem.title || '') + '"></div>';
    html += '</div>';
    html += '<div class="form-row-2col">';
    html += '<div><label>入职时间</label><input type="text" class="wh-period-start" placeholder="如：2020.03" value="' + escapeHTML(whItem.periodStart || '') + '"></div>';
    html += '<div><label>离职时间</label><input type="text" class="wh-period-end" placeholder="如：2023.06（在职填"至今"）" value="' + escapeHTML(whItem.periodEnd || '') + '"></div>';
    html += '</div>';
    html += '<label>核心职责（3-5项）</label>';
    html += '<textarea class="wh-responsibilities" rows="3" placeholder="1.&#10;2.&#10;3.">' + escapeHTML(whItem.responsibilities || '') + '</textarea>';
    html += '<label>核心业绩（量化数据）</label>';
    html += '<textarea class="wh-achievements" rows="3" placeholder="1.&#10;2.&#10;3.">' + escapeHTML(whItem.achievements || '') + '</textarea>';
    html += '<label>离职原因</label>';
    html += '<input type="text" class="wh-leaveReason" placeholder="真实离职原因（帮助AI理解你的职业决策）" value="' + escapeHTML(whItem.leaveReason || '') + '">';
    html += '</div>';
  }
  html += '</div>';
  html += '<button class="btn btn-outline" onclick="addWorkHistory()" style="margin-top:12px;width:100%">+ 添加更多工作经历</button>';
  html += '</div>';

  // Section 4: 核心业绩与成就
  html += '<div class="card"><h3>🏆 核心业绩与成就</h3>';
  html += '<label>职业生涯中最突出的5项业绩/成就（请尽量量化）</label>';
  html += '<textarea id="pf-careerAchievements" rows="6" placeholder="成就1：描述 + 关键数据 + 你的角色和贡献度&#10;成就2：...&#10;成就3：...&#10;成就4：...&#10;成就5：...">' + w('careerAchievements') + '</textarea>';
  html += '<div class="form-row-2col" style="margin-top:12px">';
  html += '<div><label>最大的3个职业优势</label><textarea id="pf-advantages" rows="3" placeholder="1.&#10;2.&#10;3.">' + w('advantages') + '</textarea></div>';
  html += '<div><label>最需要提升的2个方面</label><textarea id="pf-weaknesses" rows="3" placeholder="1.&#10;2.">' + w('weaknesses') + '</textarea></div>';
  html += '</div>';
  html += '</div>';

  // Section 5: 求职意向
  html += '<div class="card"><h3>🎯 求职意向</h3>';
  html += '<div class="form-row-2col">';
  html += '<div><label>期望的下一个岗位（1-3个方向）</label><input type="text" id="pf-targetPositions" placeholder="如：1.品牌VP（首选）2.运营总经理" value="' + w('targetPositions') + '"></div>';
  html += '<div><label>期望企业类型</label><input type="text" id="pf-targetCompanyType" placeholder="如：国际品牌/上市集团/DTC品牌..." value="' + w('targetCompanyType') + '"></div>';
  html += '</div>';
  html += '<div class="form-row-2col">';
  html += '<div><label>期望工作城市（首选+可接受）</label><input type="text" id="pf-targetCity" placeholder="如：首选上海，可接受杭州" value="' + w('targetCity') + '"></div>';
  html += '<div><label>期望薪酬范围（年/税前）</label><input type="text" id="pf-targetSalary" placeholder="如：目标80万，底线60万" value="' + w('targetSalary') + '"></div>';
  html += '</div>';
  html += '</div>';

  // Section 6: 职业困惑与价值观
  html += '<div class="card"><h3>💭 职业困惑与深层诉求</h3>';
  html += '<label>你目前最大的职业困惑是什么？</label>';
  html += '<textarea id="pf-careerConfusion" rows="4" placeholder="请详细描述，这是AI理解你需求的核心信息">' + w('careerConfusion') + '</textarea>';
  html += '<label style="margin-top:12px">考虑职业变化的核心驱动因素（按重要性选3个）</label>';
  html += '<input type="text" id="pf-careerDrivers" placeholder="如：1.薪酬增长空间受限 2.晋升空间有限 3.行业前景不佳" value="' + w('careerDrivers') + '">';
  html += '<label style="margin-top:12px">职业价值观排序（1=最重要，10=最不重要）</label>';
  html += '<textarea id="pf-careerValues" rows="3" placeholder="薪酬收入：&nbsp;| 晋升空间：&nbsp;| 工作成就感：&nbsp;| 工作生活平衡：&nbsp;| 企业品牌：&nbsp;| 团队氛围：&nbsp;| 学习成长：&nbsp;| 行业前景：&nbsp;| 稳定安全：&nbsp;| 自主权：">' + w('careerValues') + '</textarea>';
  html += '<div class="form-row-2col" style="margin-top:12px">';
  html += '<div><label>3年后期望</label><textarea id="pf-vision3year" rows="2" placeholder="岗位、收入、生活状态">' + w('vision3year') + '</textarea></div>';
  html += '<div><label>5年后期望</label><textarea id="pf-vision5year" rows="2" placeholder="更远期的愿景">' + w('vision5year') + '</textarea></div>';
  html += '</div>';
  html += '<label style="margin-top:12px">愿意为职业发展投入的方面</label>';
  html += '<input type="text" id="pf-willingInvest" placeholder="如：学习新技能、接受更大挑战、短期薪酬让步、异地发展..." value="' + w('willingInvest') + '">';
  html += '<label style="margin-top:12px">特殊限制条件（如竞业限制、经济压力、家庭因素等）</label>';
  html += '<input type="text" id="pf-constraints" placeholder="如：有竞业限制（12个月限制范围...）、房贷压力不能超过3个月空窗期..." value="' + w('constraints') + '">';
  html += '</div>';

  // Save button
  html += '<div class="card" style="text-align:center">';
  html += '<button class="btn btn-lg-full btn-primary" onclick="saveProfile()">💾 保存个人档案</button>';
  html += '<p class="section-note" style="margin-top:10px">档案仅保存在你的浏览器本地和云端同步Gist中，不会上传到任何第三方服务器。</p>';
  html += '</div>';

  container.innerHTML = html;
}

function saveProfile() {
  var p = AppState.userData.profile || {};
  var fields = ['gender','birthYear','city','hukou','marital','eduLevel','eduSchool','eduMajor','eduYear','otherEdu',
    'currentCompany','currentTitle','reportTo','teamSize','indirectTeam','salary','coreDuties',
    'careerAchievements','advantages','weaknesses','targetPositions','targetCompanyType','targetCity','targetSalary',
    'careerConfusion','careerDrivers','careerValues','vision3year','vision5year','willingInvest','constraints'];
  for (var i = 0; i < fields.length; i++) {
    var el = document.getElementById('pf-' + fields[i]);
    if (el) p[fields[i]] = el.value;
  }
  // Company info
  p.companyInfo = {
    type: (document.getElementById('pf-companyType') || {}).value || '',
    scale: (document.getElementById('pf-companyScale') || {}).value || '',
    revenue: (document.getElementById('pf-companyRevenue') || {}).value || '',
    brand: (document.getElementById('pf-companyBrand') || {}).value || '',
    stage: (document.getElementById('pf-companyStage') || {}).value || ''
  };
  // Work history
  var whBlocks = document.querySelectorAll('#profile-workHistory .wh-block');
  var wh = [];
  whBlocks.forEach(function(block) {
    var item = {
      company: (block.querySelector('.wh-company') || {}).value || '',
      title: (block.querySelector('.wh-title') || {}).value || '',
      periodStart: (block.querySelector('.wh-period-start') || {}).value || '',
      periodEnd: (block.querySelector('.wh-period-end') || {}).value || '',
      period: ((block.querySelector('.wh-period-start') || {}).value || '') + ' - ' + ((block.querySelector('.wh-period-end') || {}).value || ''),
      responsibilities: (block.querySelector('.wh-responsibilities') || {}).value || '',
      achievements: (block.querySelector('.wh-achievements') || {}).value || '',
      leaveReason: (block.querySelector('.wh-leaveReason') || {}).value || ''
    };
    if (item.company) wh.push(item);
  });
  p.workHistory = wh;
  AppState.userData.profile = p;
  saveState();
  showToast('✅ 个人档案已保存！后续所有模块的AI分析将自动包含你的档案信息。');
}

function addWorkHistory() {
  var container = document.getElementById('profile-workHistory');
  var idx = container.children.length;
  var div = document.createElement('div');
  div.className = 'wh-block';
  div.setAttribute('data-idx', idx);
  div.innerHTML = ''
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
    + '<strong>第' + (idx + 1) + '段工作经历</strong>'
    + '<button class="btn btn-sm btn-outline" onclick="removeWorkHistory(' + idx + ')" style="color:#ef4444;border-color:#ef4444;font-size:11px">删除</button>'
    + '</div>'
    + '<div class="form-row-2col">'
    + '<div><label>公司名称</label><input type="text" class="wh-company" placeholder="公司名称"></div>'
    + '<div><label>岗位名称及职级</label><input type="text" class="wh-title" placeholder="岗位+职级"></div>'
    + '</div>'
    + '<div class="form-row-2col">'
    + '<div><label>入职时间</label><input type="text" class="wh-period-start" placeholder="如：2020.03"></div>'
    + '<div><label>离职时间</label><input type="text" class="wh-period-end" placeholder="如：2023.06（在职填至今）"></div>'
    + '</div>'
    + '<label>核心职责（3-5项）</label>'
    + '<textarea class="wh-responsibilities" rows="3" placeholder="1.&#10;2.&#10;3."></textarea>'
    + '<label>核心业绩（量化数据）</label>'
    + '<textarea class="wh-achievements" rows="3" placeholder="1.&#10;2.&#10;3."></textarea>'
    + '<label>离职原因</label>'
    + '<input type="text" class="wh-leaveReason" placeholder="真实离职原因">';
  container.appendChild(div);
}

function removeWorkHistory(idx) {
  var blocks = document.querySelectorAll('#profile-workHistory .wh-block');
  if (blocks.length <= 1) { showToast('至少保留一段工作经历', true); return; }
  blocks[idx].remove();
  // Re-index
  var remaining = document.querySelectorAll('#profile-workHistory .wh-block');
  remaining.forEach(function(block, i) {
    block.setAttribute('data-idx', i);
    var title = block.querySelector('strong');
    if (title) title.textContent = '第' + (i + 1) + '段工作经历';
  });
}
function initPositioning() {
  var container = document.getElementById('positioning-container');
  var d = AppState.userData.positioning || {};
  container.innerHTML = ''
    + '<div class="card">'
    + '<h3>📋 你的基本情况</h3>'
    + '<p class="section-note">AI需要了解你的背景才能给出精准定位。信息越完整，分析越有价值。</p>'
    + '<div class="form-row-2col">'
    + '<div><label>当前行业</label><input type="text" id="pos-industry" placeholder="如：服装零售 / 互联网 / 消费品..." value="' + escapeHTML(d.industry || '') + '"></div>'
    + '<div><label>当前岗位/职级</label><input type="text" id="pos-position" placeholder="如：运营经理 / 高级产品经理..." value="' + escapeHTML(d.position || '') + '"></div>'
    + '</div>'
    + '<div class="form-row-2col">'
    + '<div><label>工作年限</label><input type="text" id="pos-years" placeholder="如：5年 / 8年（其中管理3年）" value="' + escapeHTML(d.years || '') + '"></div>'
    + '<div><label>学历/专业背景</label><input type="text" id="pos-education" placeholder="如：本科·市场营销 / 硕士·计算机" value="' + escapeHTML(d.education || '') + '"></div>'
    + '</div>'
    + '<label>一句话描述你当前的职业状态</label>'
    + '<input type="text" id="pos-status" placeholder="如：在现岗位3年，感觉遇到天花板了，想突破但不确定方向..." value="' + escapeHTML(d.status || '') + '">'
    + '</div>'

    + '<div class="mode-switch">'
    + '<button class="mode-btn active" id="pos-tab-ability" onclick="switchPosTab(\'ability\')">💪 能力自评</button>'
    + '<button class="mode-btn" id="pos-tab-interest" onclick="switchPosTab(\'interest\')">🔥 兴趣驱动力</button>'
    + '<button class="mode-btn" id="pos-tab-values" onclick="switchPosTab(\'values\')">💎 价值观</button>'
    + '</div>'
    + '<div class="card">'
    + '<h3>📊 自我评估</h3>'
    + '<p class="section-note">请用1-5分评估以下三个维度（1=薄弱/不重要，5=突出优势/最重要）</p>'
    + '<div id="pos-tab-ability-content">' + renderQuadrantSliders('ability', ['专业能力','沟通表达','向上管理','向下管理','跨部门协作','数据分析','项目管理','学习能力'], d) + '</div>'
    + '<div id="pos-tab-interest-content" style="display:none">' + renderQuadrantSliders('interest', ['创造性工作','策略规划','人际沟通','数据分析','独立执行','团队领导','专业深耕','商业变现'], d) + '</div>'
    + '<div id="pos-tab-values-content" style="display:none">' + renderQuadrantSliders('values', ['薪资待遇','工作生活平衡','成长空间','稳定性','自主权','社会影响力','团队氛围','行业前景'], d) + '</div>'
    + '</div>'

    + '<div class="card">'
    + '<h3>🚫 约束条件</h3>'
    + '<div class="form-row-2col">'
    + '<div><label>最低薪资要求（万/年）</label><input type="text" id="pos-salary-min" placeholder="如：25" value="' + escapeHTML(d.salaryMin || '') + '"></div>'
    + '<div><label>城市限制</label><input type="text" id="pos-city" placeholder="如：限杭州 / 可接受一线城市" value="' + escapeHTML(d.city || '') + '"></div>'
    + '</div>'
    + '<label>其他不能妥协的条件</label>'
    + '<input type="text" id="pos-redlines" placeholder="如：不接受长期出差、不能接受大小周、必须双休..." value="' + escapeHTML(d.redlines || '') + '">'
    + '</div>'

    + '<div class="card">'
    + '<h3>🔍 职业瓶颈诊断（7大瓶颈类型）</h3>'
    + '<p class="section-note">请勾选你当前可能遇到的瓶颈类型（可多选），AI将针对性分析。参考：职业发展瓶颈诊断体系。</p>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<label style="font-size:13px"><input type="checkbox" id="pos-bn-ceiling"' + (d.bnCeiling ? ' checked' : '') + ' style="margin-right:4px">天花板瓶颈（晋升通道堵死）</label>'
    + '<label style="font-size:13px"><input type="checkbox" id="pos-bn-ability"' + (d.bnAbility ? ' checked' : '') + ' style="margin-right:4px">能力瓶颈（核心能力不足）</label>'
    + '<label style="font-size:13px"><input type="checkbox" id="pos-bn-resource"' + (d.bnResource ? ' checked' : '') + ' style="margin-right:4px">资源瓶颈（缺人脉/信息/渠道）</label>'
    + '<label style="font-size:13px"><input type="checkbox" id="pos-bn-cognition"' + (d.bnCognition ? ' checked' : '') + ' style="margin-right:4px">认知瓶颈（看不清方向）</label>'
    + '<label style="font-size:13px"><input type="checkbox" id="pos-bn-industry"' + (d.bnIndustry ? ' checked' : '') + ' style="margin-right:4px">行业瓶颈（行业萎缩/赛道衰退）</label>'
    + '<label style="font-size:13px"><input type="checkbox" id="pos-bn-age"' + (d.bnAge ? ' checked' : '') + ' style="margin-right:4px">年龄瓶颈（35+标签/窗口关闭）</label>'
    + '<label style="font-size:13px"><input type="checkbox" id="pos-bn-label"' + (d.bnLabel ? ' checked' : '') + ' style="margin-right:4px">标签瓶颈（岗位/行业标签固化）</label>'
    + '</div>'
    + '<div style="margin-top:10px">'
    + '<div class="slider-row"><div class="slider-label"><span>瓶颈严重程度</span><span class="slider-val" id="pos-bn-level-val">' + (d.bnLevel || 3) + '/5</span></div>'
    + '<input type="range" min="1" max="5" value="' + (d.bnLevel || 3) + '" class="quad-slider" id="pos-bn-level" oninput="document.getElementById(\'pos-bn-level-val\').textContent=this.value+\'/5\'"></div>'
    + '</div>'
    + '<label style="margin-top:8px">瓶颈具体表现（可选填）</label>'
    + '<textarea id="pos-bn-detail" rows="2" placeholder="如：在总监岗做了5年没有突破，公司品牌在走下坡路，不确定该不该动..." style="width:100%">' + escapeHTML(d.bnDetail || '') + '</textarea>'
    + '</div>'

    + '<div class="card">'
    + '<h3>🎯 目标方向</h3>'
    + '<label>你理想的下一步职业方向（可以写2-3个）</label>'
    + '<textarea id="pos-goals" rows="3" placeholder="如：1. 在本行业晋升到总监 2. 跨行到互联网做运营 3. 自己创业做咨询...">' + escapeHTML(d.goals || '') + '</textarea>'
    + '<label>你最想通过职业陪跑解决的问题</label>'
    + '<textarea id="pos-question" rows="2" placeholder="如：我不知道自己适合做什么 / 我想转行但不知道怎么转 / 我担心自己的竞争力在下降...">' + escapeHTML(d.question || '') + '</textarea>'
    + '</div>'

    + '<button class="btn btn-primary btn-lg-full" onclick="processPositioning()">🧬 生成职业定位AI指令</button>'
    + '<div class="result-box" id="positioning-result"></div>'
    + '<button class="btn btn-outline" id="positioning-copy-btn" style="display:none;margin-top:8px" onclick="copyResult(\'positioning-result\')">📋 复制指令</button>'
    + '<div class="instruction"><strong>怎么用：</strong>认真填写以上信息（越诚实分析越准）→ 点击「生成AI指令」→ 复制 → 粘贴到 DeepSeek / Kimi / 豆包 等AI工具 → AI输出完整的职业定位分析报告，包含：四象限画像、竞争优势、职业锚点、发展建议。</div>';
}

function renderQuadrantSliders(prefix, items, data) {
  data = data || {};
  return items.map(function(item, i) {
    var key = prefix + '-' + i;
    var val = data[key] || 3;
    return '<div class="slider-row">'
      + '<div class="slider-label"><span>' + item + '</span><span class="slider-val" id="' + prefix + '-val-' + i + '">' + val + '/5</span></div>'
      + '<input type="range" min="1" max="5" value="' + val + '" class="quad-slider" id="' + prefix + '-slider-' + i + '" oninput="document.getElementById(\'' + prefix + '-val-' + i + '\').textContent=this.value+\'/5\'">'
      + '</div>';
  }).join('');
}

function switchPosTab(tab) {
  ['ability','interest','values'].forEach(function(t) {
    var btn = document.getElementById('pos-tab-' + t);
    var c = document.getElementById('pos-tab-' + t + '-content');
    if (t === tab) { btn.classList.add('active'); c.style.display = ''; }
    else { btn.classList.remove('active'); c.style.display = 'none'; }
  });
}

function processPositioning() {
  var resultBox = document.getElementById('positioning-result');
  showSpinner('positioning-result');
  document.getElementById('positioning-copy-btn').style.display = 'none';

  useOneCredit(function() {
    var industry = document.getElementById('pos-industry').value || '【未填】';
    var position = document.getElementById('pos-position').value || '【未填】';
    var years = document.getElementById('pos-years').value || '【未填】';
    var education = document.getElementById('pos-education').value || '【未填】';
    var status = document.getElementById('pos-status').value || '【未填】';
    var goals = document.getElementById('pos-goals').value || '【未填】';
    var question = document.getElementById('pos-question').value || '【未填】';
    // 瓶颈诊断数据
    var bnTypes = [];
    if (document.getElementById('pos-bn-ceiling')?.checked) bnTypes.push('天花板瓶颈');
    if (document.getElementById('pos-bn-ability')?.checked) bnTypes.push('能力瓶颈');
    if (document.getElementById('pos-bn-resource')?.checked) bnTypes.push('资源瓶颈');
    if (document.getElementById('pos-bn-cognition')?.checked) bnTypes.push('认知瓶颈');
    if (document.getElementById('pos-bn-industry')?.checked) bnTypes.push('行业瓶颈');
    if (document.getElementById('pos-bn-age')?.checked) bnTypes.push('年龄瓶颈');
    if (document.getElementById('pos-bn-label')?.checked) bnTypes.push('标签瓶颈');
    var bnLevel = document.getElementById('pos-bn-level')?.value || 3;
    var bnDetail = document.getElementById('pos-bn-detail')?.value || '';
    var salaryMin = document.getElementById('pos-salary-min').value || '【未填】';
    var city = document.getElementById('pos-city').value || '【未填】';
    var redlines = document.getElementById('pos-redlines').value || '无';

    // 收集能力、兴趣、价值观自评
    var abilities = ['专业能力','沟通表达','向上管理','向下管理','跨部门协作','数据分析','项目管理','学习能力'];
    var interests = ['创造性工作','策略规划','人际沟通','数据分析','独立执行','团队领导','专业深耕','商业变现'];
    var values = ['薪资待遇','工作生活平衡','成长空间','稳定性','自主权','社会影响力','团队氛围','行业前景'];
    function collectScores(prefix, items) {
      return items.map(function(item, i) {
        var val = document.getElementById(prefix + '-slider-' + i)?.value || 3;
        return item + '：' + val + '/5';
      }).join('\n');
    }

    var raw = '你是一位资深职业规划师，拥有15年职业咨询经验，帮助过2000+职场人完成职业定位和转型。请根据以下信息，为我做一次系统的职业定位分析。\n\n'
      + '## 我的基本情况\n'
      + '- 当前行业：' + industry + '\n'
      + '- 当前岗位/职级：' + position + '\n'
      + '- 工作年限：' + years + '\n'
      + '- 学历/专业：' + education + '\n'
      + '- 当前状态：' + status + '\n\n'
      + '## 能力自评（1-5分）\n' + collectScores('ability', abilities) + '\n\n'
      + '## 兴趣与驱动力（1-5分）\n' + collectScores('interest', interests) + '\n\n'
      + '## 价值观排序（1-5分）\n' + collectScores('values', values) + '\n\n'
      + '## 约束条件\n'
      + '- 最低薪资要求：' + salaryMin + '万/年\n'
      + '- 城市限制：' + city + '\n'
      + '- 其他红线：' + redlines + '\n\n'
      + '## 目标方向\n' + goals + '\n\n'
      + '## 我最想解决的问题\n' + question + '\n\n'
      + '## 职业瓶颈自诊\n'
      + '- 自评瓶颈类型：' + (bnTypes.length > 0 ? bnTypes.join('、') : '未选择') + '\n'
      + '- 瓶颈严重程度：' + bnLevel + '/5\n'
      + '- 具体表现：' + (bnDetail || '未填写') + '\n\n'
      + '## 请按以下框架输出职业定位分析报告\n\n'
      + '### 一、四象限全景画像\n'
      + '根据我的能力、兴趣、价值观和约束条件，用"优势-劣势-机会-威胁"框架整合分析：\n'
      + '- 我的核心竞争力是什么？（能力自评≥4分的项目组合起来说明什么？）\n'
      + '- 我的内在驱动力来自哪里？（兴趣和价值观的高分项揭示什么职业倾向？）\n'
      + '- 我的核心约束如何影响职业选择范围？\n\n'
      + '### 二、职业锚点判断\n'
      + '根据Schein职业锚理论，判断我最可能属于哪种职业锚（技术/职能型、管理型、自主/独立型、安全/稳定型、创业型、服务型、挑战型、生活型），并说明判断依据。\n\n'
      + '### 三、竞争优势分析\n'
      + '- 我在当前行业/岗位的不可替代性有多强？\n'
      + '- 我的能力组合在哪些行业/岗位上最有溢价？\n'
      + '- 我的经验壁垒有多高？\n\n'
      + '### 四、发展方向建议\n'
      + '针对我的目标方向"' + goals + '"，逐一分析：\n'
      + '- 可行性评估（我的能力-目标匹配度）\n'
      + '- 转型/晋升的关键瓶颈是什么？\n'
      + '- 大概需要多长时间？\n'
      + '- 建议的优先级排序\n\n'
      + '### 五、风险与策略\n'
      + '- 我的三大能力短板怎么补？\n'
      + '- 如果我想转行/转型，最大的风险和应对方案\n'
      + '- 如果继续在现有赛道深耕，机会在哪里？\n\n'
      + '### 六、下一步行动建议\n'
      + '- 未来3个月最优先做的3件事\n'
      + '- 我应该重点关注什么信号来判断方向对不对\n\n'
      + '## 重要规则\n'
      + '- 诚实分析，不要为了让我舒服而说好话\n'
      + '- 如果你发现我的自评有矛盾（如能力自评很高但状态描述很迷茫），指出来\n'
      + '- 每条建议都要具体可执行，禁止"提升自己""加强学习"这种废话\n'
      + '- 如果我的信息不够做完整判断，明确指出需要补充什么';

    var prompt = wrapPrompt(raw, '职业定位', '');
    resultBox.classList.remove('loading');
    resultBox.textContent = prompt;
    document.getElementById('positioning-copy-btn').style.display = 'inline-block';
    savePositioningData();
  }, function(err) {
    document.getElementById('positioning-result').classList.remove('show');
    showToast(err, true);
  });
}

function savePositioningData() {
  var d = {};
  ['industry','position','years','education','status','goals','question','salaryMin','city','redlines','bnDetail'].forEach(function(k) {
    var el = document.getElementById('pos-' + k);
    if (el) d[k] = el.value;
  });
  ['ability','interest','values'].forEach(function(prefix) {
    for (var i = 0; i < 8; i++) {
      var el = document.getElementById(prefix + '-slider-' + i);
      if (el) d[prefix + '-' + i] = el.value;
    }
  });
  // 瓶颈诊断
  ['bnCeiling','bnAbility','bnResource','bnCognition','bnIndustry','bnAge','bnLabel'].forEach(function(k) {
    var el = document.getElementById('pos-' + k);
    if (el) d[k] = el.checked;
  });
  var bnLevelEl = document.getElementById('pos-bn-level');
  if (bnLevelEl) d.bnLevel = bnLevelEl.value;
  AppState.userData.positioning = d;
  saveState();
}

// ============================================================
// 模块2：职业路线
// ============================================================
function initRoadmap() {
  var container = document.getElementById('roadmap-container');
  var d = AppState.userData.roadmap || {};
  container.innerHTML = ''
    + '<div class="card">'
    + '<h3>📍 当前状态</h3>'
    + '<div class="form-row-2col">'
    + '<div><label>当前行业</label><select id="rm-cur-industry">' + buildIndustryOptions(d.curIndustry) + '</select></div>'
    + '<div><label>当前岗位方向</label><select id="rm-cur-position">' + buildPositionOptions(d.curPosition) + '</select></div>'
    + '</div>'
    + '<div class="form-row-2col">'
    + '<div><label>当前职级</label><input type="text" id="rm-cur-level" placeholder="如：高级经理 / 总监" value="' + escapeHTML(d.curLevel || '') + '"></div>'
    + '<div><label>当前年薪（万）</label><input type="text" id="rm-cur-salary" placeholder="如：45" value="' + escapeHTML(d.curSalary || '') + '"></div>'
    + '</div>'
    + '</div>'

    + '<div class="card">'
    + '<h3>🎯 目标方向</h3>'
    + '<div class="form-row-2col">'
    + '<div><label>目标行业</label><select id="rm-target-industry">' + buildIndustryOptions(d.targetIndustry) + '</select></div>'
    + '<div><label>目标岗位</label><select id="rm-target-position">' + buildPositionOptions(d.targetPosition) + '</select></div>'
    + '</div>'
    + '<div class="form-row-2col">'
    + '<div><label>发展路径类型</label><select id="rm-path-type"><option value="">--选择路径--</option><option value="管理路线"' + (d.pathType === '管理路线' ? ' selected' : '') + '>管理路线（主管→经理→总监→VP→CEO）</option><option value="专业路线"' + (d.pathType === '专业路线' ? ' selected' : '') + '>专业路线（专员→资深→专家→首席顾问）</option><option value="创业路线"' + (d.pathType === '创业路线' ? ' selected' : '') + '>创业路线（职业经理人→合伙人→创始人）</option></select></div>'
    + '<div><label>期望晋升层级</label><select id="rm-target-level"><option value="">--选择层级--</option><option value="经理级"' + (d.targetLevel === '经理级' ? ' selected' : '') + '>经理级（20-50万）</option><option value="总监级"' + (d.targetLevel === '总监级' ? ' selected' : '') + '>总监级（40-100万）</option><option value="VP级"' + (d.targetLevel === 'VP级' ? ' selected' : '') + '>VP级（80-200万）</option><option value="C-suite"' + (d.targetLevel === 'C-suite' ? ' selected' : '') + '>C-suite（150-500万+）</option></select></div>'
    + '</div>'
    + '<label>期望的时间线</label>'
    + '<select id="rm-timeline"><option value="3个月内"' + (d.timeline === '3个月内' ? ' selected' : '') + '>3个月内</option><option value="6个月内"' + (d.timeline === '6个月内' ? ' selected' : '') + '>6个月内</option><option value="1年内"' + (d.timeline === '1年内' ? ' selected' : '') + '>1年内</option><option value="1-2年"' + (d.timeline === '1-2年' ? ' selected' : '') + '>1-2年</option></select>'
    + '<label>转型的幅度</label>'
    + '<select id="rm-change-level"><option value="同行业晋升"' + (d.changeLevel === '同行业晋升' ? ' selected' : '') + '>同行业晋升（最稳）</option><option value="同行业换岗"' + (d.changeLevel === '同行业换岗' ? ' selected' : '') + '>同行业换岗（中等风险）</option><option value="跨行业同岗"' + (d.changeLevel === '跨行业同岗' ? ' selected' : '') + '>跨行业同岗（中高风险）</option><option value="跨行业跨岗"' + (d.changeLevel === '跨行业跨岗' ? ' selected' : '') + '>跨行业跨岗（最高风险）</option></select>'
    + '</div>'

    + '<div class="card">'
    + '<h3>⏱ 约束与资源</h3>'
    + '<div class="form-row-2col">'
    + '<div><label>城市限制</label><input type="text" id="rm-city" placeholder="如：只限杭州" value="' + escapeHTML(d.city || '') + '"></div>'
    + '<div><label>最低年薪要求（万）</label><input type="text" id="rm-salary-min" placeholder="如：40" value="' + escapeHTML(d.salaryMin || '') + '"></div>'
    + '</div>'
    + '<label>每周可用于职业发展的时间</label>'
    + '<select id="rm-weekly-hours"><option value="5小时以内"' + (d.weeklyHours === '5小时以内' ? ' selected' : '') + '>5小时以内（碎片时间）</option><option value="5-10小时"' + (d.weeklyHours === '5-10小时' ? ' selected' : '') + '>5-10小时（早晚+周末）</option><option value="10-20小时"' + (d.weeklyHours === '10-20小时' ? ' selected' : '') + '>10-20小时（全力投入）</option><option value="全职准备"' + (d.weeklyHours === '全职准备' ? ' selected' : '') + '>全职准备（已离职/即将离职）</option></select>'
    + '<label>你最大的顾虑或担心</label>'
    + '<textarea id="rm-worry" rows="2" placeholder="如：担心年龄大了竞争力下降 / 担心换了行业从头开始不值得 / 担心家里不支持...">' + escapeHTML(d.worry || '') + '</textarea>'
    + '</div>'

    + '<div class="card">'
    + '<h3>🔄 跨行业/跨岗能力迁移评估</h3>'
    + '<p class="section-note">如果你考虑转行或转岗，请评估你的可迁移能力。同行业晋升可跳过此部分。</p>'
    + '<label>你的TOP3可迁移能力（那些在任何行业/岗位都有价值的能力）</label>'
    + '<textarea id="rm-transferable" rows="2" placeholder="如：1. 数据分析与商业洞察 2. 团队管理与领导力 3. 跨部门资源协调">' + escapeHTML(d.transferable || '') + '</textarea>'
    + '<label>你的行业专长（只在特定行业有价值的知识/经验/资源）</label>'
    + '<textarea id="rm-industry-specific" rows="2" placeholder="如：服装行业供应链人脉、零售终端运营方法论、面料成本核算经验...">' + escapeHTML(d.industrySpecific || '') + '</textarea>'
    + '<label>你愿意从零开始学习的领域（如果有）</label>'
    + '<input type="text" id="rm-learn-new" placeholder="如：AI工具应用、数据分析、社群运营..." value="' + escapeHTML(d.learnNew || '') + '">'
    + '<label>你愿意接受的降薪幅度（转行往往需要降薪起步）</label>'
    + '<select id="rm-salary-cut"><option value="">--请选择--</option><option value="不接受降薪"' + (d.salaryCut === '不接受降薪' ? ' selected' : '') + '>不接受降薪</option><option value="可降10%以内"' + (d.salaryCut === '可降10%以内' ? ' selected' : '') + '>可降10%以内</option><option value="可降10-20%"' + (d.salaryCut === '可降10-20%' ? ' selected' : '') + '>可降10-20%</option><option value="可降20-30%"' + (d.salaryCut === '可降20-30%' ? ' selected' : '') + '>可降20-30%</option><option value="短期降薪30%以上也可接受"' + (d.salaryCut === '短期降薪30%以上也可接受' ? ' selected' : '') + '>短期降薪30%以上也可接受</option></select>'
    + '</div>'

    + '<button class="btn btn-primary btn-lg-full" onclick="processRoadmap()">🗺️ 生成职业路线AI指令</button>'
    + '<div class="result-box" id="roadmap-result"></div>'
    + '<button class="btn btn-outline" id="roadmap-copy-btn" style="display:none;margin-top:8px" onclick="copyResult(\'roadmap-result\')">📋 复制指令</button>'
    + '<div class="instruction"><strong>怎么用：</strong>诚实填写当前状态和目标（信息越真实AI建议越靠谱）→ 点击生成指令 → 复制 → 粘贴到AI工具 → AI输出3条路径对比分析+风险评估+90天冲刺计划。</div>';
}

function buildIndustryOptions(selected) {
  var opts = '<option value="">--选择行业--</option>';
  Object.keys(INDUSTRY_DATA).forEach(function(ind) {
    opts += '<option value="' + ind + '"' + (selected === ind ? ' selected' : '') + '>' + ind + '</option>';
  });
  opts += '<option value="其他行业"' + (selected === '其他行业' ? ' selected' : '') + '>其他行业（请在下方说明）</option>';
  return opts;
}

function buildPositionOptions(selected) {
  var opts = '<option value="">--选择岗位方向--</option>';
  Object.keys(POSITION_FRAMEWORK).forEach(function(p) {
    opts += '<option value="' + p + '"' + (selected === p ? ' selected' : '') + '>' + p + '</option>';
  });
  opts += '<option value="其他岗位"' + (selected === '其他岗位' ? ' selected' : '') + '>其他岗位（请在下方说明）</option>';
  return opts;
}

function processRoadmap() {
  var resultBox = document.getElementById('roadmap-result');
  showSpinner('roadmap-result');
  document.getElementById('roadmap-copy-btn').style.display = 'none';

  useOneCredit(function() {
    var curIndustry = document.getElementById('rm-cur-industry').value || '【未填】';
    var curPosition = document.getElementById('rm-cur-position').value || '【未填】';
    var curLevel = document.getElementById('rm-cur-level').value || '【未填】';
    var curSalary = document.getElementById('rm-cur-salary').value || '【未填】';
    var targetIndustry = document.getElementById('rm-target-industry').value || '【未填】';
    var targetPosition = document.getElementById('rm-target-position').value || '【未填】';
    var pathType = document.getElementById('rm-path-type')?.value || '';
    var targetLevel = document.getElementById('rm-target-level')?.value || '';
    var timeline = document.getElementById('rm-timeline').value || '【未填】';
    var changeLevel = document.getElementById('rm-change-level').value || '【未填】';
    var city = document.getElementById('rm-city').value || '【未填】';
    var salaryMin = document.getElementById('rm-salary-min').value || '【未填】';
    var weeklyHours = document.getElementById('rm-weekly-hours').value || '【未填】';
    var worry = document.getElementById('rm-worry').value || '无';
    var transferable = document.getElementById('rm-transferable')?.value || '';
    var industrySpecific = document.getElementById('rm-industry-specific')?.value || '';
    var learnNew = document.getElementById('rm-learn-new')?.value || '';
    var salaryCut = document.getElementById('rm-salary-cut')?.value || '';

    var raw = '你是一位资深职业战略顾问，拥有15年职业规划经验，帮助过2000+人完成职业转型和晋升。请帮我设计职业路线规划。\n\n'
      + '## 当前状态\n'
      + '- 行业：' + curIndustry + '\n'
      + '- 岗位方向：' + curPosition + '\n'
      + '- 职级：' + curLevel + '\n'
      + '- 年薪：' + curSalary + '万\n\n'
      + '## 目标方向\n'
      + '- 目标行业：' + targetIndustry + '\n'
      + '- 目标岗位：' + targetPosition + '\n'
      + (pathType ? '- 发展路径类型：' + pathType + '\n' : '')
      + (targetLevel ? '- 期望晋升层级：' + targetLevel + '\n' : '')
      + '- 期望时间线：' + timeline + '\n'
      + '- 转型幅度：' + changeLevel + '\n\n'
      + '## 约束与资源\n'
      + '- 城市：' + city + '\n'
      + '- 最低年薪：' + salaryMin + '万\n'
      + '- 每周可用时间：' + weeklyHours + '\n'
      + '- 最大顾虑：' + worry + '\n'
      + (transferable ? '- 可迁移能力：' + transferable + '\n' : '')
      + (industrySpecific ? '- 行业专长：' + industrySpecific + '\n' : '')
      + (learnNew ? '- 愿意从零学习：' + learnNew + '\n' : '')
      + (salaryCut ? '- 可接受降薪幅度：' + salaryCut + '\n' : '')
      + '\n'
      + '## 请按以下框架输出职业路线规划报告\n\n'
      + '### 一、现状诊断\n'
      + '- 当前岗位的市场价值评估（对标行业薪酬水平）\n'
      + '- 当前赛道的天花板高度和上升空间\n'
      + '- 如果不做任何改变，1年/3年后大概会是什么状态？\n\n'
      + '### 二、三条路径设计\n'
      + '设计3条可选的职业路径：\n'
      + '**路径A：稳健晋升**（同行业/同岗位向上发展）\n'
      + '- 具体怎么走？分几步？\n'
      + '- 最佳情景/最差情景/最可能情景\n'
      + '- 成功率和关键前提条件\n\n'
      + '**路径B：跨界平移**（换行业但岗位方向相似，或换岗位但行业不变）\n'
      + '- 具体怎么走？分几步？\n'
      + '- 最佳情景/最差情景/最可能情景\n'
      + '- 成功率和关键前提条件\n\n'
      + '**路径C：跃迁突破**（更高的职位/更好的平台/更快的成长）\n'
      + '- 具体怎么走？分几步？\n'
      + '- 最佳情景/最差情景/最可能情景\n'
      + '- 成功率和关键前提条件\n\n'
      + '### 三、路径对比矩阵\n'
      + '从以下维度对比三条路径：时间成本、经济成本、风险等级、上限空间、成功率、与个人约束的匹配度\n\n'
      + '### 四、推荐方案\n'
      + '- 首推哪条路径？为什么？\n'
      + '- 如果首选路径受阻，备选是什么？\n'
      + '- 建议的第一步行动是什么？\n\n'
      + '### 五、90天冲刺计划\n'
      + '针对推荐路径，拆解30-60-90天行动计划：\n'
      + '- 第1-30天：打基础（该做什么？预期成果？）\n'
      + '- 第31-60天：发力期（该做什么？预期成果？）\n'
      + '- 第61-90天：冲刺期（该做什么？预期成果？）\n'
      + '- 每周时间分配建议（基于你每周' + weeklyHours + '的时间投入）\n\n'
      + '### 六、风险预案\n'
      + '- 如果' + timeline + '没达到预期，Plan B是什么？\n'
      + '- 什么信号说明"这条路可能不对"？\n'
      + '- 如果市场行情变差，怎么调整？\n\n'
      + '## 重要规则\n'
      + '- 不要只说好听的，诚实分析每条路径的风险\n'
      + '- 路径设计要具体到行业、岗位、薪资范围\n'
      + '- 90天计划要可执行，每个动作要"下周就可以开始做"\n'
      + '- 如果我的信息不足以支撑完整判断，明确指出缺少什么';

    var prompt = wrapPrompt(raw, '职业路线', '');
    resultBox.classList.remove('loading');
    resultBox.textContent = prompt;
    document.getElementById('roadmap-copy-btn').style.display = 'inline-block';
    saveRoadmapData();
  }, function(err) {
    document.getElementById('roadmap-result').classList.remove('show');
    showToast(err, true);
  });
}

function saveRoadmapData() {
  var d = {};
  ['curIndustry','curPosition','curLevel','curSalary','targetIndustry','targetPosition','pathType','targetLevel','timeline','changeLevel','city','salaryMin','weeklyHours','worry','transferable','industrySpecific','learnNew','salaryCut'].forEach(function(k) {
    d[k] = document.getElementById('rm-' + k)?.value || '';
  });
  AppState.userData.roadmap = d;
  saveState();
}

// ============================================================
// 模块3：职业能力工具箱
// ============================================================
var currentToolkitTab = 'resume';

function initToolkit() {
  var container = document.getElementById('toolkit-container');
  container.innerHTML = ''
    + '<div class="mode-switch">'
    + '<button class="mode-btn active" id="tk-tab-resume" onclick="switchToolkitTab(\'resume\')">📄 简历优化</button>'
    + '<button class="mode-btn" id="tk-tab-interview" onclick="switchToolkitTab(\'interview\')">💬 面试话术</button>'
    + '<button class="mode-btn" id="tk-tab-salary" onclick="switchToolkitTab(\'salary\')">💰 谈薪策略</button>'
    + '<button class="mode-btn" id="tk-tab-decision" onclick="switchToolkitTab(\'decision\')">🧮 职业决策</button>'
    + '</div>'
    + '<div id="toolkit-tab-content"></div>'
    + '<div class="result-box" id="toolkit-result"></div>'
    + '<button class="btn btn-outline" id="toolkit-copy-btn" style="display:none;margin-top:8px" onclick="copyResult(\'toolkit-result\')">📋 复制指令</button>'
    + '<div class="instruction"><strong>怎么用：</strong>选择场景 → 填写你的具体情况 → 生成AI指令 → 粘贴到AI工具 → 获得专业输出。</div>';
  switchToolkitTab('resume');
}

function switchToolkitTab(tab) {
  currentToolkitTab = tab;
  document.querySelectorAll('.mode-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('tk-tab-' + tab)?.classList.add('active');
  document.getElementById('toolkit-result').classList.remove('show');
  document.getElementById('toolkit-copy-btn').style.display = 'none';

  var content = document.getElementById('toolkit-tab-content');
  var d = AppState.userData.toolkit || {};

  if (tab === 'resume') {
    content.innerHTML = '<div class="card">'
      + '<h3>📄 简历优化工作台</h3>'
      + '<label>目标岗位</label><input type="text" id="tk-resume-position" placeholder="如：运营总监 / 产品经理" value="' + escapeHTML(d.resumePosition || '') + '">'
      + '<label>目标行业/公司类型</label><input type="text" id="tk-resume-industry" placeholder="如：互联网中厂 / 服装行业头部 / 创业公司" value="' + escapeHTML(d.resumeIndustry || '') + '">'
      + '<label>粘贴你当前的简历全文</label>'
      + '<textarea id="tk-resume-text" rows="10" placeholder="在此粘贴你的简历全文...">' + escapeHTML(d.resumeText || '') + '</textarea>'
      + '<label>你最想让简历突出的亮点（可选）</label>'
      + '<input type="text" id="tk-resume-highlight" placeholder="如：操盘过千万级项目 / 从0到1搭建团队" value="' + escapeHTML(d.resumeHighlight || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processToolkit()">📄 生成简历优化指令</button>'
      + '</div>';
  } else if (tab === 'interview') {
    content.innerHTML = '<div class="card">'
      + '<h3>💬 面试话术生成</h3>'
      + '<label>应聘岗位</label><input type="text" id="tk-int-position" placeholder="如：运营总监" value="' + escapeHTML(d.intPosition || '') + '">'
      + '<label>公司类型/规模</label><input type="text" id="tk-int-company" placeholder="如：B轮创业公司150人 / 上市公司" value="' + escapeHTML(d.intCompany || '') + '">'
      + '<label>你最怕被问的问题（可选）</label>'
      + '<textarea id="tk-int-worry" rows="2" placeholder="如：你为什么离开上一家公司？你的缺点是什么？你期待的薪资是多少？...">' + escapeHTML(d.intWorry || '') + '</textarea>'
      + '<label>你最想展示的优势</label>'
      + '<textarea id="tk-int-strength" rows="2" placeholder="如：我带过20人团队、操盘过年GMV 5000万的业务...">' + escapeHTML(d.intStrength || '') + '</textarea>'
      + '<button class="btn btn-primary btn-lg-full" onclick="processToolkit()">💬 生成面试话术指令</button>'
      + '</div>';
  } else if (tab === 'salary') {
    content.innerHTML = '<div class="card">'
      + '<h3>💰 谈薪策略</h3>'
      + '<label>目标岗位</label><input type="text" id="tk-sal-position" placeholder="如：高级运营经理" value="' + escapeHTML(d.salPosition || '') + '">'
      + '<label>目标公司类型</label><input type="text" id="tk-sal-company" placeholder="如：互联网中厂 / 外企 / 创业公司" value="' + escapeHTML(d.salCompany || '') + '">'
      + '<div class="form-row-2col">'
      + '<div><label>当前年薪（万）</label><input type="text" id="tk-sal-current" placeholder="如：45" value="' + escapeHTML(d.salCurrent || '') + '"></div>'
      + '<div><label>期望年薪（万）</label><input type="text" id="tk-sal-target" placeholder="如：60" value="' + escapeHTML(d.salTarget || '') + '"></div>'
      + '</div>'
      + '<label>你能接受的底线（万）</label><input type="text" id="tk-sal-floor" placeholder="如：50" value="' + escapeHTML(d.salFloor || '') + '">'
      + '<label>对方可能的顾虑（可选）</label>'
      + '<input type="text" id="tk-sal-concern" placeholder="如：涨幅太高HR可能卡 / 我的经验偏少..." value="' + escapeHTML(d.salConcern || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processToolkit()">💰 生成谈薪策略指令</button>'
      + '</div>';
  } else if (tab === 'decision') {
    content.innerHTML = '<div class="card">'
      + '<h3>🧮 职业决策推演</h3>'
      + '<label>你要做的决策是什么？</label>'
      + '<input type="text" id="tk-dec-question" placeholder="如：要不要接这个offer？要不要离职去创业？" value="' + escapeHTML(d.decQuestion || '') + '">'
      + '<label>背景情况</label>'
      + '<textarea id="tk-dec-context" rows="3" placeholder="如：现在在一家稳定的大公司，拿到一个创业公司的offer，薪资涨30%但风险也大...">' + escapeHTML(d.decContext || '') + '</textarea>'
      + '<label>可选方案（至少2个）</label>'
      + '<textarea id="tk-dec-options" rows="4" placeholder="方案A：留在现公司，争取晋升\n方案B：接创业公司offer\n方案C：再找找其他机会...">' + escapeHTML(d.decOptions || '') + '</textarea>'
      + '<label>你最担心的风险</label>'
      + '<input type="text" id="tk-dec-risk" placeholder="如：创业公司不稳定，万一几个月后倒闭..." value="' + escapeHTML(d.decRisk || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processToolkit()">🧮 生成决策推演指令</button>'
      + '</div>';
  }
  restoreDrafts();
}

function processToolkit() {
  var resultBox = document.getElementById('toolkit-result');
  showSpinner('toolkit-result');
  document.getElementById('toolkit-copy-btn').style.display = 'none';

  useOneCredit(function() {
    var tab = currentToolkitTab;
    var raw = '';
    var modeName = '';

    if (tab === 'resume') {
      modeName = '简历优化';
      var position = document.getElementById('tk-resume-position').value || '【请填写】';
      var industry = document.getElementById('tk-resume-industry').value || '【请填写】';
      var text = document.getElementById('tk-resume-text').value || '【请粘贴简历】';
      var highlight = document.getElementById('tk-resume-highlight').value || '无';
      raw = '你是一位资深招聘总监兼简历专家，拥有15年招聘经验，审阅过10万+份简历。请帮我优化简历。\n\n'
        + '## 背景\n- 目标岗位：' + position + '\n- 目标行业：' + industry + '\n- 我最想突出的亮点：' + highlight + '\n\n'
        + '## 我的简历\n' + text + '\n\n'
        + '## 请从以下维度优化\n\n'
        + '### 一、简历诊断（8维评分，每项1-10分）\n'
        + '1. 结构清晰度 2. 量化数据密度 3. 成就导向性 4. 关键词匹配度 5. 语言精炼度 6. 差异化竞争力 7. 阅读体验 8. 通过ATS筛选的概率\n\n'
        + '### 二、逐段修改\n- 每段经历用STAR法则重写：情境→任务→行动→结果\n- 把"负责XX"改为"通过XX方法实现XX结果（数据）"\n- 删除所有"责任心强""善于沟通"等空洞自评\n\n'
        + '### 三、岗位定制\n- 根据"' + position + '"的JD要求，调整简历关键词和重点\n- 建议新增/删除的内容\n\n'
        + '### 四、改写后的完整版本\n- 直接给我一个优化后的简历版本\n\n'
        + '## 规则：每个修改都要说明为什么，只给具体的改写建议，不要"加强""优化"这种废话。';

    } else if (tab === 'interview') {
      modeName = '面试话术';
      var position2 = document.getElementById('tk-int-position').value || '【请填写】';
      var company = document.getElementById('tk-int-company').value || '【请填写】';
      var worry = document.getElementById('tk-int-worry').value || '无';
      var strength = document.getElementById('tk-int-strength').value || '【请填写】';
      raw = '你是一位资深面试教练，帮助过2000+人拿到心仪offer。请帮我准备面试话术。\n\n'
        + '## 背景\n- 应聘岗位：' + position2 + '\n- 目标公司类型：' + company + '\n- 我最怕被问的：' + worry + '\n- 我最想展示的：' + strength + '\n\n'
        + '## 请帮我准备以下内容的面试话术\n\n'
        + '### 一、自我介绍（1分钟版和3分钟版）\n- 不要复述简历，要说"我能为你带来什么"\n\n'
        + '### 二、高频问题逐题攻略\n- 每个问题给：标准回答框架 + 具体话术 + 好回答标准 + 红旗信号\n- 必含：自我介绍、离职原因、优缺点、职业规划、期望薪资、为什么选我们\n- 针对我最怕的"' + worry + '"，重点设计2-3种回应策略\n\n'
        + '### 三、反问环节\n- 帮我设计5个高质量反问（体现思考深度，不是走过场）\n\n'
        + '### 四、面试节奏控制\n- 如何自然地把话题引向我的优势？\n- 被问到弱项时怎么应对？\n\n'
        + '## 规则：话术要口语化、自然，不要像背稿子。每个回答要体现"' + strength + '"这个核心卖点。';

    } else if (tab === 'salary') {
      modeName = '谈薪策略';
      var salPosition = document.getElementById('tk-sal-position').value || '【请填写】';
      var salCompany = document.getElementById('tk-sal-company').value || '【请填写】';
      var salCurrent = document.getElementById('tk-sal-current').value || '【请填写】';
      var salTarget = document.getElementById('tk-sal-target').value || '【请填写】';
      var salFloor = document.getElementById('tk-sal-floor').value || '【请填写】';
      var salConcern = document.getElementById('tk-sal-concern').value || '无';
      raw = '你是一位资深薪酬谈判顾问，帮助过1000+人拿到理想薪资。请帮我制定谈薪策略。\n\n'
        + '## 背景\n- 岗位：' + salPosition + '\n- 公司类型：' + salCompany + '\n- 当前年薪：' + salCurrent + '万\n- 期望年薪：' + salTarget + '万\n- 底线：' + salFloor + '万\n- 可能的顾虑：' + salConcern + '\n\n'
        + '## 请帮我制定谈薪策略\n\n'
        + '### 一、薪酬定位\n- 目标岗位在' + salCompany + '的市场薪酬范围（25分位/50分位/75分位）\n- 我的期望' + salTarget + '万在什么水平？合理吗？\n\n'
        + '### 二、谈判筹码分析\n- 我有哪些可以用来谈判的筹码？\n- 除了base薪资，还可以谈什么？（股票/期权、签字费、绩效奖金、福利、职级、汇报线...）\n\n'
        + '### 三、谈判话术\n- HR问"你现在薪资多少"怎么答？\n- HR说"涨幅太高我们给不了"怎么回？\n- HR说"我们有薪资体系不能破"怎么应对？\n- 什么时候该让步？什么时候该坚持？\n\n'
        + '### 四、谈判节奏\n- 整个谈薪过程分几步？\n- 什么信号说明"可以再往上要"？\n- 什么信号说明"到顶了"？\n\n'
        + '## 规则：话术要自然实用，不要教条。考虑中国人的沟通习惯，不要太直接。';

    } else if (tab === 'decision') {
      modeName = '职业决策';
      var decQuestion = document.getElementById('tk-dec-question').value || '【请填写】';
      var decContext = document.getElementById('tk-dec-context').value || '【请填写】';
      var decOptions = document.getElementById('tk-dec-options').value || '【请填写】';
      var decRisk = document.getElementById('tk-dec-risk').value || '【请填写】';
      raw = '你是一位资深职业决策顾问，帮助过3000+人做关键职业决策。请帮我推演这个决定。你不替我做决定，但帮我把每个选项想清楚。\n\n'
        + '## 决策背景\n- 核心问题：' + decQuestion + '\n- 当前情况：' + decContext + '\n- 可选方案：\n' + decOptions + '\n- 最担心的风险：' + decRisk + '\n\n'
        + '## 请按以下框架推演\n\n'
        + '### 一、决策的本质\n- 这个决策真正在决定什么？\n- 不做决策的代价是什么？\n\n'
        + '### 二、各方案情景推演\n对每个方案做：最佳情景/最差情景/最可能情景\n\n'
        + '### 三、关键前提检验\n- 每个方案成立需要什么前提条件？\n- 这些条件现在具备吗？\n\n'
        + '### 四、风险矩阵\n各方案TOP3风险 + 可能性 + 影响程度 + 应对预案\n\n'
        + '### 五、决策建议\n- 如果只看确定性，选哪个？\n- 如果看上限空间，选哪个？\n- 有没有渐进路径？\n\n'
        + '## 规则：不替我做决定，但帮我看清每个选择的真实代价。如果我的信息不够，明确指出。';
    }

    var prompt = wrapPrompt(raw, '职业能力', modeName);
    resultBox.classList.remove('loading');
    resultBox.textContent = prompt;
    document.getElementById('toolkit-copy-btn').style.display = 'inline-block';
    saveToolkitData();
  }, function(err) {
    document.getElementById('toolkit-result').classList.remove('show');
    showToast(err, true);
  });
}

function saveToolkitData() {
  var d = AppState.userData.toolkit || {};
  var ids = ['tk-resume-position','tk-resume-industry','tk-resume-text','tk-resume-highlight',
    'tk-int-position','tk-int-company','tk-int-worry','tk-int-strength',
    'tk-sal-position','tk-sal-company','tk-sal-current','tk-sal-target','tk-sal-floor','tk-sal-concern',
    'tk-dec-question','tk-dec-context','tk-dec-options','tk-dec-risk'];
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) d[id.replace('tk-', '')] = el.value;
  });
  AppState.userData.toolkit = d;
  saveState();
}

// ============================================================
// 模块4：职业实战中心
// ============================================================
var currentCombatTab = 'resume';

function initCombat() {
  var container = document.getElementById('combat-container');
  container.innerHTML = ''
    + '<div class="mode-switch">'
    + '<button class="mode-btn active" id="cb-tab-resume" onclick="switchCombatTab(\'resume\')">📝 简历分析</button>'
    + '<button class="mode-btn" id="cb-tab-interview" onclick="switchCombatTab(\'interview\')">🎙️ 模拟面试</button>'
    + '<button class="mode-btn" id="cb-tab-skills" onclick="switchCombatTab(\'skills\')">🏋️ 技能训练</button>'
    + '<button class="mode-btn" id="cb-tab-challenge" onclick="switchCombatTab(\'challenge\')">📋 实战挑战</button>'
    + '<button class="mode-btn" id="cb-tab-network" onclick="switchCombatTab(\'network\')">🤝 人脉建设</button>'
    + '<button class="mode-btn" id="cb-tab-brand" onclick="switchCombatTab(\'brand\')">📣 个人品牌</button>'
    + '</div>'
    + '<div id="combat-tab-content"></div>'
    + '<div class="result-box" id="combat-result"></div>'
    + '<button class="btn btn-outline" id="combat-copy-btn" style="display:none;margin-top:8px" onclick="copyResult(\'combat-result\')">📋 复制指令</button>'
    + '<div class="instruction"><strong>怎么用：</strong>选择实战场景 → 填写你的具体情况 → 生成AI指令 → 粘贴到AI工具 → AI作为你的职业教练进行深度分析和训练。</div>';
  switchCombatTab('resume');
}

function switchCombatTab(tab) {
  currentCombatTab = tab;
  document.querySelectorAll('#combat-container .mode-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('cb-tab-' + tab)?.classList.add('active');
  document.getElementById('combat-result').classList.remove('show');
  document.getElementById('combat-copy-btn').style.display = 'none';

  var content = document.getElementById('combat-tab-content');
  var d = AppState.userData.combat || {};

  if (tab === 'resume') {
    content.innerHTML = '<div class="card">'
      + '<h3>📝 简历深度分析</h3>'
      + '<p class="section-note">粘贴简历全文，AI从7个维度评分并给出逐条改进建议。</p>'
      + '<label>目标岗位</label><input type="text" id="cb-resume-position" placeholder="如：运营总监" value="' + escapeHTML(d.cbResumePosition || '') + '">'
      + '<textarea id="cb-resume-text" rows="12" placeholder="在此粘贴你的简历全文...">' + escapeHTML(d.cbResumeText || '') + '</textarea>'
      + '<button class="btn btn-primary btn-lg-full" onclick="processCombat()">📝 生成简历分析指令</button>'
      + '</div>';
  } else if (tab === 'interview') {
    content.innerHTML = '<div class="card">'
      + '<h3>🎙️ 模拟面试训练</h3>'
      + '<label>目标岗位</label><input type="text" id="cb-int-position" placeholder="如：运营总监 / 产品VP" value="' + escapeHTML(d.cbIntPosition || '') + '">'
      + '<label>公司阶段与规模</label><input type="text" id="cb-int-company" placeholder="如：B轮200人 / 上市公司5000人" value="' + escapeHTML(d.cbIntCompany || '') + '">'
      + '<label>你最担心的面试环节</label>'
      + '<select id="cb-int-focus"><option value="行为面试"' + (d.cbIntFocus === '行为面试' ? ' selected' : '') + '>行为面试（STAR法则）</option><option value="案例分析"' + (d.cbIntFocus === '案例分析' ? ' selected' : '') + '>案例分析/业务题</option><option value="压力面试"' + (d.cbIntFocus === '压力面试' ? ' selected' : '') + '>压力面试/追问</option><option value="高管面"' + (d.cbIntFocus === '高管面' ? ' selected' : '') + '>高管终面</option><option value="全面准备"' + (d.cbIntFocus === '全面准备' ? ' selected' : '') + '>全面准备</option></select>'
      + '<label>你的优势描述</label>'
      + '<textarea id="cb-int-strength" rows="2" placeholder="如：5年运营管理经验，从0到1搭建过团队...">' + escapeHTML(d.cbIntStrength || '') + '</textarea>'
      + '<button class="btn btn-primary btn-lg-full" onclick="processCombat()">🎙️ 生成模拟面试指令</button>'
      + '</div>';
  } else if (tab === 'skills') {
    content.innerHTML = '<div class="card">'
      + '<h3>🏋️ 技能专项训练</h3>'
      + '<label>你想提升的技能</label>'
      + '<select id="cb-skills-area"><option value="向上管理"' + (d.cbSkillsArea === '向上管理' ? ' selected' : '') + '>向上管理</option><option value="向下管理/带团队"' + (d.cbSkillsArea === '向下管理/带团队' ? ' selected' : '') + '>向下管理/带团队</option><option value="跨部门协作"' + (d.cbSkillsArea === '跨部门协作' ? ' selected' : '') + '>跨部门协作</option><option value="数据分析"' + (d.cbSkillsArea === '数据分析' ? ' selected' : '') + '>数据分析</option><option value="公开演讲/汇报"' + (d.cbSkillsArea === '公开演讲/汇报' ? ' selected' : '') + '>公开演讲/汇报</option><option value="项目管理"' + (d.cbSkillsArea === '项目管理' ? ' selected' : '') + '>项目管理</option><option value="商业思维"' + (d.cbSkillsArea === '商业思维' ? ' selected' : '') + '>商业思维</option></select>'
      + '<label>你当前的水平描述</label>'
      + '<textarea id="cb-skills-current" rows="2" placeholder="如：向上管理总是把握不好度，要么太被动要么太aggressive...">' + escapeHTML(d.cbSkillsCurrent || '') + '</textarea>'
      + '<label>具体工作场景（AI会给针对性训练方案）</label>'
      + '<textarea id="cb-skills-scene" rows="2" placeholder="如：下周要跟老板做季度汇报，我想趁这个机会展示我的成果但不知道怎么讲...">' + escapeHTML(d.cbSkillsScene || '') + '</textarea>'
      + '<button class="btn btn-primary btn-lg-full" onclick="processCombat()">🏋️ 生成技能训练指令</button>'
      + '</div>';
  } else if (tab === 'challenge') {
    content.innerHTML = '<div class="card">'
      + '<h3>📋 实战挑战分析</h3>'
      + '<p class="section-note">描述你在工作中遇到的一个具体挑战，AI帮你分析根因和应对策略。</p>'
      + '<label>你的岗位和背景</label><input type="text" id="cb-challenge-bg" placeholder="如：运营经理，管5个人，入职1年" value="' + escapeHTML(d.cbChallengeBg || '') + '">'
      + '<label>你面临的具体挑战</label>'
      + '<textarea id="cb-challenge-desc" rows="4" placeholder="如：团队里有个老员工不配合我的安排，当着全组的面质疑我的方案，其他同事也开始站队...">' + escapeHTML(d.cbChallengeDesc || '') + '</textarea>'
      + '<label>你已经尝试过什么方法？（可选）</label>'
      + '<textarea id="cb-challenge-tried" rows="2" placeholder="如：私下找他聊过一次，他说会配合但后面还是老样子...">' + escapeHTML(d.cbChallengeTried || '') + '</textarea>'
      + '<button class="btn btn-primary btn-lg-full" onclick="processCombat()">📋 生成实战分析指令</button>'
      + '</div>';
  } else if (tab === 'network') {
    content.innerHTML = '<div class="card">'
      + '<h3>🤝 人脉建设策略</h3>'
      + '<p class="section-note">中高端岗位70%靠内推和人脉。AI帮你设计系统化的人脉建设方案。</p>'
      + '<label>你当前的行业与岗位</label><input type="text" id="cb-network-position" placeholder="如：服装零售行业运营总监" value="' + escapeHTML(d.cbNetworkPosition || '') + '">'
      + '<label>你目前的人脉状况</label>'
      + '<textarea id="cb-network-current" rows="3" placeholder="如：行业内有几个熟人但不多，LinkedIn上有500+联系人但基本不互动，行业峰会偶尔参加但从没主动社交过...">' + escapeHTML(d.cbNetworkCurrent || '') + '</textarea>'
      + '<label>你的人脉建设目标</label>'
      + '<select id="cb-network-goal"><option value="找到新机会"' + (d.cbNetworkGoal === '找到新机会' ? ' selected' : '') + '>找到新工作/新机会</option><option value="行业影响力"' + (d.cbNetworkGoal === '行业影响力' ? ' selected' : '') + '>建立行业影响力</option><option value="学习成长"' + (d.cbNetworkGoal === '学习成长' ? ' selected' : '') + '>链接导师和学习资源</option><option value="商业合作"' + (d.cbNetworkGoal === '商业合作' ? ' selected' : '') + '>拓展商业合作机会</option><option value="全面构建"' + (d.cbNetworkGoal === '全面构建' ? ' selected' : '') + '>全面构建职业网络</option></select>'
      + '<label>你最大的社交障碍或顾虑</label>'
      + '<input type="text" id="cb-network-blocker" placeholder="如：不知道聊什么 / 怕被拒绝 / 觉得社交很累 / 没什么机会接触大咖..." value="' + escapeHTML(d.cbNetworkBlocker || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processCombat()">🤝 生成人脉建设指令</button>'
      + '</div>';
  } else if (tab === 'brand') {
    content.innerHTML = '<div class="card">'
      + '<h3>📣 个人品牌建设</h3>'
      + '<p class="section-note">在职场上，别人对你的认知就是你的品牌。AI帮你建立差异化个人品牌。</p>'
      + '<label>你当前的岗位和行业</label><input type="text" id="cb-brand-position" placeholder="如：服装行业商品管理总监" value="' + escapeHTML(d.cbBrandPosition || '') + '">'
      + '<label>你最想让行业/同行记住你的3个标签</label>'
      + '<textarea id="cb-brand-tags" rows="2" placeholder="如：1. 数据驱动的商品企划专家 2. 擅长从0到1搭建商品体系 3. 服装行业趋势洞察者">' + escapeHTML(d.cbBrandTags || '') + '</textarea>'
      + '<label>你目前在哪些平台上建立了个人品牌？（可多选）</label>'
      + '<input type="text" id="cb-brand-platforms" placeholder="如：脉脉、LinkedIn、行业社群、公众号、知乎、小红书、什么平台都没有..." value="' + escapeHTML(d.cbBrandPlatforms || '') + '">'
      + '<label>你的品牌建设目标</label>'
      + '<select id="cb-brand-goal"><option value="行业知名度"' + (d.cbBrandGoal === '行业知名度' ? ' selected' : '') + '>提升行业知名度和影响力</option><option value="求职竞争力"' + (d.cbBrandGoal === '求职竞争力' ? ' selected' : '') + '>增强求职竞争力</option><option value="变现"' + (d.cbBrandGoal === '变现' ? ' selected' : '') + '>个人品牌变现（培训/咨询/内容）</option><option value="从零开始"' + (d.cbBrandGoal === '从零开始' ? ' selected' : '') + '>从零开始建立个人品牌</option></select>'
      + '<label>你的内容输出能力（你擅长或愿意尝试的输出方式）</label>'
      + '<input type="text" id="cb-brand-content" placeholder="如：写文章、做PPT分享、拍短视频、直播、线下分享、都不擅长但愿意学..." value="' + escapeHTML(d.cbBrandContent || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processCombat()">📣 生成个人品牌指令</button>'
      + '</div>';
  }
  restoreDrafts();
}

function processCombat() {
  var resultBox = document.getElementById('combat-result');
  showSpinner('combat-result');
  document.getElementById('combat-copy-btn').style.display = 'none';

  useOneCredit(function() {
    var tab = currentCombatTab;
    var raw = '';
    var modeName = '';

    if (tab === 'resume') {
      modeName = '简历分析';
      var pos = document.getElementById('cb-resume-position').value || '【请填写】';
      var text = document.getElementById('cb-resume-text').value || '【请粘贴简历】';
      raw = '你是一位资深招聘总监兼简历专家，审阅过10万+份简历。请深度分析我的简历。\n\n'
        + '## 目标岗位\n' + pos + '\n\n## 简历全文\n' + text + '\n\n'
        + '## 分析框架\n\n### 一、7维诊断（每项1-5分+具体理由）\n'
        + '结构清晰度 | 内容量化度 | 成就导向性 | 定位精准度 | 语言表达力 | 专业规范性 | 差异化竞争力\n\n'
        + '### 二、逐段修改建议\n- 每段经历指出：哪里好、哪里不好、怎么改\n- 把"负责XX"格式改为"通过XX方法实现XX结果（+数据）"\n- 找出并删除所有空洞自评\n\n'
        + '### 三、岗位匹配分析\n- 简历关键词与"' + pos + '"JD的匹配度\n- 缺什么关键词/能力项\n\n'
        + '### 四、改写后的精华版\n- 给我一个优化后的版本\n\n'
        + '## 规则：直接说实话，不要客气。每条建议必须给"改成什么样"，不是"应该优化"。';

    } else if (tab === 'interview') {
      modeName = '模拟面试';
      var intPos = document.getElementById('cb-int-position').value || '【请填写】';
      var intCompany = document.getElementById('cb-int-company').value || '【请填写】';
      var intFocus = document.getElementById('cb-int-focus').value || '全面准备';
      var intStrength = document.getElementById('cb-int-strength').value || '【请填写】';
      raw = '你是一位资深面试教练兼行业面试官，面试过2000+位候选人。请针对以下情况帮我做模拟面试训练。\n\n'
        + '## 背景\n- 目标岗位：' + intPos + '\n- 公司类型：' + intCompany + '\n- 重点准备：' + intFocus + '\n- 我的优势：' + intStrength + '\n\n'
        + '## 请输出\n\n### 一、针对' + intFocus + '的15道面试题\n- 每道题包含：考察点、好回答框架、具体话术参考、红旗信号、递进追问\n\n'
        + '### 二、模拟面试脚本\n- 给我一段完整的面试对话示例（面试官问 → 我怎么答 → 面试官追问 → 我怎么回）\n\n'
        + '### 三、我的优势"' + intStrength + '"如何在面试中自然展现\n- 不要生硬地自夸，设计3个"故事钩子"让面试官自己追问\n\n'
        + '### 四、常见翻车点\n- ' + intPos + '面试中最容易翻车的3个问题及应对\n\n'
        + '## 规则：题目要有穿透力，避免网上能搜到的套路题。';

    } else if (tab === 'skills') {
      modeName = '技能训练';
      var area = document.getElementById('cb-skills-area').value || '【请选择】';
      var current = document.getElementById('cb-skills-current').value || '【请填写】';
      var scene = document.getElementById('cb-skills-scene').value || '无';
      raw = '你是一位资深职场技能教练，帮助过3000+人提升核心职业能力。请帮我设计技能训练方案。\n\n'
        + '## 背景\n- 想提升的技能：' + area + '\n- 当前水平：' + current + '\n- 具体场景：' + scene + '\n\n'
        + '## 请输出\n\n### 一、能力诊断\n- ' + area + '的能力模型拆解（这个技能由哪些子能力构成？）\n- 根据我的描述，我的水平大概在什么阶段？\n- 核心短板判断\n\n'
        + '### 二、2周刻意练习计划\n- 每天具体做什么（要可以明天就开始做）\n- 每阶段要练到什么标准\n- 怎么判断自己进步了\n\n'
        + (scene !== '无' ? '### 三、场景实战\n- 针对"' + scene + '"这个具体场景，给我一个详细的行动脚本\n- 包含：开场怎么说、中间怎么应对、收尾怎么总结\n\n' : '')
        + '### 四、常见错误和纠正\n- 练' + area + '最容易犯的3个错误\n- 怎么避免\n\n'
        + '## 规则：练习方案要具体到"每天做什么"，不要理论堆砌。';

    } else if (tab === 'challenge') {
      modeName = '实战挑战';
      var bg = document.getElementById('cb-challenge-bg').value || '【请填写】';
      var desc = document.getElementById('cb-challenge-desc').value || '【请填写】';
      var tried = document.getElementById('cb-challenge-tried').value || '尚未尝试';
      raw = '你是一位资深职场导师兼管理顾问，帮助过2000+人解决职场难题。请帮我分析这个工作挑战。\n\n'
        + '## 背景\n- 我的角色：' + bg + '\n- 具体挑战：' + desc + '\n- 已经尝试过：' + tried + '\n\n'
        + '## 请输出\n\n### 一、问题诊断\n- 这个问题的本质是什么？（往往不是表面上那个问题）\n- 根因分析：是能力问题、关系问题、结构问题还是期望问题？\n\n'
        + '### 二、3种应对方案\n- 方案A（温和型）：怎么做？什么结果？风险？\n- 方案B（进取型）：怎么做？什么结果？风险？\n- 方案C（借力型）：怎么做？什么结果？风险？\n\n'
        + '### 三、行动脚本\n- 推荐方案的详细行动步骤\n- 什么信号说明策略有效？什么信号说明要调整？\n\n'
        + '### 四、长期建议\n- 这个挑战反映了什么需要提升的能力？\n- 怎么避免类似问题再次发生？\n\n'
        + '## 规则：方案要具体到"明天去跟XX说什么话"，不要给理论。';

    } else if (tab === 'network') {
      modeName = '人脉建设';
      var nwPos = document.getElementById('cb-network-position').value || '【请填写】';
      var nwCurrent = document.getElementById('cb-network-current').value || '【请填写】';
      var nwGoal = document.getElementById('cb-network-goal').value || '【请选择】';
      var nwBlocker = document.getElementById('cb-network-blocker').value || '无';
      raw = '你是一位资深职业发展顾问兼人脉策略专家，帮助过1000+位职场人建立高质量职业网络。请帮我制定人脉建设策略。\n\n'
        + '## 背景\n- 我的行业与岗位：' + nwPos + '\n- 当前人脉状况：' + nwCurrent + '\n- 建设目标：' + nwGoal + '\n- 最大障碍：' + nwBlocker + '\n\n'
        + '## 请按以下框架输出\n\n'
        + '### 一、人脉现状诊断\n- 根据我的描述，我的人脉网络处于什么阶段？（孤立期/建立期/扩展期/影响力期）\n- 我的核心短板是什么？\n\n'
        + '### 二、目标人脉地图\n- 针对"' + nwGoal + '"这个目标，我应该链接哪些人？\n- 把目标人脉分成3层：核心层（10人）、影响层（50人）、关注层（200人）\n- 每层应该包含什么类型的人？\n\n'
        + '### 三、30天人脉行动计划\n- 第1-7天：梳理现有人脉 + 列出目标人脉清单\n- 第8-14天：开始轻度互动（点赞/评论/转发）+ 参加1次行业活动\n- 第15-21天：约3-5次一对一咖啡/线上聊\n- 第22-30天：提供价值（分享/介绍/帮助）\n\n'
        + '### 四、社交话术和技巧\n- 如何自然地给陌生人发私信？给3个模板\n- 如何在行业会议上有效社交？给具体行动指南\n- 如何维护长期人脉关系而不显得功利？\n- 针对"' + nwBlocker + '"这个障碍的破解方法\n\n'
        + '### 五、平台策略\n- LinkedIn/脉脉/行业社群/线下活动 各自的策略重点\n- 每周人脉建设的时间分配建议\n\n'
        + '## 规则：策略要具体到"联系谁、说什么、什么时候说"。不要讲"多认识人"这种废话。';

    } else if (tab === 'brand') {
      modeName = '个人品牌';
      var brPos = document.getElementById('cb-brand-position').value || '【请填写】';
      var brTags = document.getElementById('cb-brand-tags').value || '【请填写】';
      var brPlatforms = document.getElementById('cb-brand-platforms').value || '【请填写】';
      var brGoal = document.getElementById('cb-brand-goal').value || '【请选择】';
      var brContent = document.getElementById('cb-brand-content').value || '【请填写】';
      raw = '你是一位资深个人品牌顾问，帮助过500+位职场人和创业者建立个人品牌。请帮我制定个人品牌建设方案。\n\n'
        + '## 背景\n- 我的岗位和行业：' + brPos + '\n- 我想建立的标签：' + brTags + '\n- 现有平台基础：' + brPlatforms + '\n- 建设目标：' + brGoal + '\n- 内容输出能力：' + brContent + '\n\n'
        + '## 请按以下框架输出\n\n'
        + '### 一、品牌定位\n- 基于我的岗位和标签，帮我提炼一个差异化的个人品牌定位（一句话）\n- 在"' + brPos + '"这个领域，什么定位是稀缺且有价值的？\n\n'
        + '### 二、内容策略\n- 我应该输出什么类型的内容？（专业洞察/经验分享/案例分析/趋势解读/实操干货）\n- 给我10个具体的内容选题，直接可以写的那种\n- 适合我的内容形式是什么？（考虑到我的输出能力：' + brContent + '）\n\n'
        + '### 三、平台选择与运营\n- 基于我的目标"' + brGoal + '"，哪些平台应该优先做？\n- 各平台的发布频率和内容策略\n- 起步阶段的90天内容日历框架\n\n'
        + '### 四、影响力放大器\n- 如何在行业社群里建立专业形象？（话术+行为指南）\n- 如何利用公司内部的分享机会（内部培训/跨部门分享/年会演讲）\n- 是否应该参加行业论坛/圆桌/播客？如何争取机会？\n\n'
        + '### 五、变现路径（如适用）\n- 如果目标是变现，从免费分享到付费服务的路径是什么？\n- 什么信号说明品牌建设进入了正轨？\n\n'
        + '## 规则：定位要窄不要宽，内容要深不要泛。给我具体的行动方案，不要"建立个人品牌"这种空话。';

    }

    var prompt = wrapPrompt(raw, '职业实战', modeName);
    resultBox.classList.remove('loading');
    resultBox.textContent = prompt;
    document.getElementById('combat-copy-btn').style.display = 'inline-block';
    saveCombatData();
  }, function(err) {
    document.getElementById('combat-result').classList.remove('show');
    showToast(err, true);
  });
}

function saveCombatData() {
  var d = AppState.userData.combat || {};
  var ids = ['cb-resume-position','cb-resume-text','cb-int-position','cb-int-company','cb-int-focus','cb-int-strength',
    'cb-skills-area','cb-skills-current','cb-skills-scene','cb-challenge-bg','cb-challenge-desc','cb-challenge-tried',
    'cb-network-position','cb-network-current','cb-network-goal','cb-network-blocker',
    'cb-brand-position','cb-brand-tags','cb-brand-platforms','cb-brand-goal','cb-brand-content'];
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) d[id] = el.value;
  });
  AppState.userData.combat = d;
  saveState();
}

// ============================================================
// 模块5：职业复盘
// ============================================================
var currentReviewMode = 'weekly';

function initReview() {
  var container = document.getElementById('review-container');
  container.innerHTML = ''
    + '<div class="mode-switch">'
    + '<button class="mode-btn active" id="rv-mode-weekly" onclick="switchReviewMode(\'weekly\')">📋 每周复盘</button>'
    + '<button class="mode-btn" id="rv-mode-monthly" onclick="switchReviewMode(\'monthly\')">📅 月度深盘</button>'
    + '<button class="mode-btn" id="rv-mode-history" onclick="switchReviewMode(\'history\')">📚 复盘历史</button>'
	    + '<button class="mode-btn" id="rv-mode-annual" onclick="switchReviewMode(\'annual\')">📊 年度复盘</button>'
    + '</div>'
    + '<div id="review-tab-content"></div>'
    + '<div class="result-box" id="review-result"></div>'
    + '<button class="btn btn-outline" id="review-copy-btn" style="display:none;margin-top:8px" onclick="copyResult(\'review-result\')">📋 复制指令</button>'
    + '<div class="instruction"><strong>怎么用：</strong>填写你的复盘数据 → 生成AI指令 → 粘贴到AI工具 → AI帮你做深度复盘分析，揭示你忽略的模式和盲点。</div>';
  switchReviewMode('weekly');
}

function switchReviewMode(mode) {
  currentReviewMode = mode;
  document.querySelectorAll('#review-container .mode-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('rv-mode-' + mode)?.classList.add('active');
  document.getElementById('review-result').classList.remove('show');
  document.getElementById('review-copy-btn').style.display = 'none';

  var content = document.getElementById('review-tab-content');
  var d = AppState.userData.review || {};

  if (mode === 'weekly') {
    content.innerHTML = '<div class="card">'
      + '<h3>📋 每周复盘</h3>'
      + '<p class="section-note">诚实复盘才能带来真正的成长。每个问题都值得认真回答。</p>'
      + '<label>本周日期范围</label><input type="text" id="rv-weekly-date" placeholder="如：5.1-5.7" value="' + escapeHTML(d.weeklyDate || '') + '">'
      + '<label>本周TOP 3关键事项（做了什么？结果如何？）</label>'
      + '<textarea id="rv-weekly-top3" rows="3" placeholder="1.&#10;2.&#10;3.">' + escapeHTML(d.weeklyTop3 || '') + '</textarea>'
      + '<label>本周最大的成就是什么？为什么？</label>'
      + '<input type="text" id="rv-weekly-achievement" placeholder="如：独立完成季度汇报，老板很满意" value="' + escapeHTML(d.weeklyAchievement || '') + '">'
      + '<label>本周最大的挫折或遗憾？学到什么？</label>'
      + '<input type="text" id="rv-weekly-setback" placeholder="如：一个重点项目延期了，因为我高估了团队的进度" value="' + escapeHTML(d.weeklySetback || '') + '">'
      + '<label>本周时间分配合理吗？（哪些事占用了不该占用的时间？）</label>'
      + '<textarea id="rv-weekly-time" rows="2" placeholder="如：花了太多时间在救火上，真正重要的事只推进了30%...">' + escapeHTML(d.weeklyTime || '') + '</textarea>'
      + '<label>下周最重要的1件事（只有一件！）</label>'
      + '<input type="text" id="rv-weekly-next" placeholder="如：完成竞品分析报告的第一版" value="' + escapeHTML(d.weeklyNext || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processReview()">📋 生成复盘分析指令</button>'
      + '</div>';
  } else if (mode === 'monthly') {
    content.innerHTML = '<div class="card">'
      + '<h3>📅 月度战略复盘</h3>'
      + '<label>复盘月份</label><input type="text" id="rv-monthly-date" placeholder="如：2026年4月" value="' + escapeHTML(d.monthlyDate || '') + '">'
      + '<label>本月核心目标达成率（自评%）</label><input type="text" id="rv-monthly-goalrate" placeholder="如：70%——完成了A和B，C项目基本没动" value="' + escapeHTML(d.monthlyGoalrate || '') + '">'
      + '<label>本月最大的收获（能力的、认知的、关系的都可以）</label>'
      + '<textarea id="rv-monthly-gain" rows="2" placeholder="如：这月最大的认知是，与其花时间说服不配合的人，不如把精力放在支持我的人身上...">' + escapeHTML(d.monthlyGain || '') + '</textarea>'
      + '<label>本月遇到的困难和应对</label>'
      + '<textarea id="rv-monthly-challenge" rows="2" placeholder="如：跨部门协作遇到了阻力，我尝试了一对一沟通但效果不好...">' + escapeHTML(d.monthlyChallenge || '') + '</textarea>'
      + '<label>能力成长自评（本月在哪个能力上有进步？哪个能力有退步？）</label>'
      + '<textarea id="rv-monthly-skills" rows="2" placeholder="如：向上汇报能力有提升（做的3次汇报都获好评）；但向下沟通变弱了（团队最近士气低）...">' + escapeHTML(d.monthlySkills || '') + '</textarea>'
      + '<label>对当前职业方向的满意度（1-10分）为什么？</label>'
      + '<input type="text" id="rv-monthly-satisfaction" placeholder="如：7分——工作内容还行但感觉成长速度变慢了" value="' + escapeHTML(d.monthlySatisfaction || '') + '">'
      + '<label>下个月最重要的3个目标</label>'
      + '<textarea id="rv-monthly-next" rows="2" placeholder="1.&#10;2.&#10;3.">' + escapeHTML(d.monthlyNext || '') + '</textarea>'
      + '<button class="btn btn-primary btn-lg-full" onclick="processReview()">📅 生成月度复盘指令</button>'
      + '</div>';
  } else if (mode === 'history') {
    var history = JSON.parse(localStorage.getItem('prompt_history') || '[]');
    var reviewHistory = history.filter(function(h) { return h.module === '职业复盘'; });
    var html = '<div class="card"><h3>📚 复盘历史</h3>';
    if (reviewHistory.length === 0) {
      html += '<p class="section-note">还没有复盘记录。完成第一次复盘后，这里会显示你的复盘历史。</p>';
    } else {
      html += reviewHistory.map(function(h) {
        var d = new Date(h.date);
        var safeCopy = (h.preview || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return '<div class="history-item" style="cursor:pointer;margin-bottom:8px" data-copy="' + safeCopy + '" onclick="navigator.clipboard.writeText(this.getAttribute(\'data-copy\'))"><div class="hi-date">' + d.toLocaleDateString('zh-CN') + ' · ' + escapeHTML(h.mode || '') + '</div></div>';
      }).join('');
    }
    html += '</div>';
    content.innerHTML = html;
    return;
  } else if (mode === 'annual') {
    content.innerHTML = '<div class="card">'
      + '<h3>📊 年度复盘</h3>'
      + '<p class="section-note">一年之计在于复盘。请诚实回顾这一年的职业发展轨迹。</p>'
      + '<label>复盘年份</label><input type="text" id="rv-annual-year" placeholder="如：2026" value="' + escapeHTML(d.annualYear || '') + '">'
      + '<label>这一年你的核心角色/身份发生了什么变化？</label>'
      + '<textarea id="rv-annual-role" rows="2" placeholder="如：从高级经理晋升为总监，从执行者变成管理者...">' + escapeHTML(d.annualRole || '') + '</textarea>'
      + '<label>年度TOP 5成就（按重要性排序，说事实不说感觉）</label>'
      + '<textarea id="rv-annual-top5" rows="4" placeholder="1.&#10;2.&#10;3.&#10;4.&#10;5.">' + escapeHTML(d.annualTop5 || '') + '</textarea>'
      + '<label>年度最大的3个教训/挫折（从中你学到了什么？）</label>'
      + '<textarea id="rv-annual-lessons" rows="3" placeholder="1.&#10;2.&#10;3.">' + escapeHTML(d.annualLessons || '') + '</textarea>'
      + '<label>与一年前相比，你在哪些能力上有质的提升？</label>'
      + '<textarea id="rv-annual-skillgrowth" rows="2" placeholder="如：管理能力从管5人提升到管20人；商业判断力从执行思维升级到战略思维...">' + escapeHTML(d.annualSkillgrowth || '') + '</textarea>'
      + '<label>对当前职业赛道的满意度（1-10分）和原因</label>'
      + '<input type="text" id="rv-annual-satisfaction" placeholder="如：6分——赛道还行但天花板明显，想探索新方向" value="' + escapeHTML(d.annualSatisfaction || '') + '">'
      + '<label>下一年度最重要的3个目标</label>'
      + '<textarea id="rv-annual-nextgoals" rows="3" placeholder="1.&#10;2.&#10;3.">' + escapeHTML(d.annualNextgoals || '') + '</textarea>'
      + '<label>用一个词或一句话总结你的这一年</label>'
      + '<input type="text" id="rv-annual-summary" placeholder="如：从迷茫到清晰的一年 / 量变积累的一年 / 转折之年" value="' + escapeHTML(d.annualSummary || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processReview()">📊 生成年度复盘指令</button>'
      + '</div>';
    return;
  }
  restoreDrafts();
}

function processReview() {
  var resultBox = document.getElementById('review-result');
  showSpinner('review-result');
  document.getElementById('review-copy-btn').style.display = 'none';

  useOneCredit(function() {
    var mode = currentReviewMode;
    var raw = '';
    var modeName = '';

    if (mode === 'weekly') {
      modeName = '每周复盘';
      var date = document.getElementById('rv-weekly-date').value || '【未填】';
      var top3 = document.getElementById('rv-weekly-top3').value || '【未填】';
      var achievement = document.getElementById('rv-weekly-achievement').value || '【未填】';
      var setback = document.getElementById('rv-weekly-setback').value || '【未填】';
      var time = document.getElementById('rv-weekly-time').value || '【未填】';
      var next = document.getElementById('rv-weekly-next').value || '【未填】';
      raw = '你是一位资深职业教练，擅长通过复盘帮助职场人发现盲点、加速成长。请帮我做本周的深度复盘。\n\n'
        + '## 本周数据\n- 日期：' + date + '\n- TOP3事项：\n' + top3 + '\n- 最大成就：' + achievement + '\n- 最大挫折：' + setback + '\n- 时间分配：' + time + '\n- 下周最重要的一件事：' + next + '\n\n'
        + '## 请从以下维度复盘\n\n'
        + '### 一、本周总体评价\n- 这周的产出质量如何？（不是问"忙不忙"，是问"有没有推进真正重要的事"）\n- 这周是"高效周"还是"假忙周"？\n\n'
        + '### 二、模式识别\n- 从我的TOP3和成就/挫折中，你能看出什么模式？\n- 哪些事反复出现？（好的和坏的都要说）\n- 我的时间分配和我的目标对齐吗？\n\n'
        + '### 三、关键洞察\n- 本周最大的学习是什么？（从成就和挫折中各提炼一个）\n- 有没有我可能忽略的盲点？\n\n'
        + '### 四、下周建议\n- 针对"' + next + '"这个目标，建议怎么推进？\n- 下周最应该停止做什么？最应该开始做什么？\n- 如果下周只能完成一件事，应该是哪件？\n\n'
        + '## 规则：直接、诚实，不要夸我。如果发现我的时间分配明显有问题，指出来。';

    } else if (mode === 'monthly') {
      modeName = '月度复盘';
      var mdate = document.getElementById('rv-monthly-date').value || '【未填】';
      var goalrate = document.getElementById('rv-monthly-goalrate').value || '【未填】';
      var gain = document.getElementById('rv-monthly-gain').value || '【未填】';
      var challenge = document.getElementById('rv-monthly-challenge').value || '【未填】';
      var skills = document.getElementById('rv-monthly-skills').value || '【未填】';
      var satisfaction = document.getElementById('rv-monthly-satisfaction').value || '【未填】';
      var mnext = document.getElementById('rv-monthly-next').value || '【未填】';
      raw = '你是一位资深职业教练兼战略顾问，擅长月度战略复盘。请帮我做' + mdate + '的深度复盘。\n\n'
        + '## 本月数据\n- 目标达成率：' + goalrate + '\n- 最大收获：' + gain + '\n- 遇到的困难：' + challenge + '\n- 能力变化：' + skills + '\n- 职业满意度：' + satisfaction + '\n- 下月目标：\n' + mnext + '\n\n'
        + '## 请从以下维度深度复盘\n\n'
        + '### 一、目标与实际差距分析\n- 目标达成率' + goalrate + '背后的真正原因\n- 是目标定高了还是执行力不够？还是外部因素？\n\n'
        + '### 二、能力成长盘点\n- 本月能力是在上升、持平还是下降？\n- 什么能力进步最快？什么能力在退化？\n- 我的能力发展趋势跟职业目标匹配吗？\n\n'
        + '### 三、职业方向校准\n- 基于本月的体验和感受，我现在的职业方向需要调整吗？\n- 满意度' + satisfaction + '是在升高还是降低？趋势说明什么？\n\n'
        + '### 四、下月战略建议\n- 下月3个目标的优先级是否需要调整？\n- 建议下月重点抓哪个目标？\n- 什么信号出现说明"方向偏了"？\n\n'
        + '### 五、季度趋势观察\n- 把本月放进最近3个月的上下文看，有什么趋势？\n- 是好趋势还是坏趋势？\n\n'
        + '## 规则：既要复盘过去，也要校准未来。如果发现我的方向跟能力趋势不匹配，直接说。';
      } else if (mode === 'annual') {
        modeName = '年度复盘';
        var aYear = document.getElementById('rv-annual-year').value || '【未填】';
        var aRole = document.getElementById('rv-annual-role').value || '【未填】';
        var aTop5 = document.getElementById('rv-annual-top5').value || '【未填】';
        var aLessons = document.getElementById('rv-annual-lessons').value || '【未填】';
        var aSkillgrowth = document.getElementById('rv-annual-skillgrowth').value || '【未填】';
        var aSatisfaction = document.getElementById('rv-annual-satisfaction').value || '【未填】';
        var aNextgoals = document.getElementById('rv-annual-nextgoals').value || '【未填】';
        var aSummary = document.getElementById('rv-annual-summary').value || '【未填】';
        raw = '你是一位资深职业教练兼生涯规划顾问，拥有15年高管辅导经验。请帮我做' + aYear + '年度深度复盘与战略规划。\n\n'
          + '## 本年数据\n- 角色变化：' + aRole + '\n- TOP5成就：\n' + aTop5 + '\n- 3大教训：\n' + aLessons + '\n- 能力提升：' + aSkillgrowth + '\n- 赛道满意度：' + aSatisfaction + '\n- 年度关键词：' + aSummary + '\n- 下年目标：\n' + aNextgoals + '\n\n'
          + '## 请按以下框架深度复盘\n\n'
          + '### 一、年度成就审视\n- 今年TOP5成就背后有什么共同模式？\n- 哪些成绩是能力的体现？哪些是运气/环境红利？\n- 如果今年只能留一件最重要的成果，是什么？为什么？\n\n'
          + '### 二、成长轨迹分析\n- 对比去年同期，你最大的变化是什么？（不只是职位/薪资，还有认知/能力/资源/影响力）\n- 今年的成长速度是快、慢还是停滞？跟同龄人比处于什么位置？\n- 哪个能力上了一个台阶？哪个能力是短板且越来越限制你？\n\n'
          + '### 三、教训与模式识别\n- 今年3大教训背后有什么深层模式？\n- 有没有重复犯的错误？说明什么？\n- 你今年的决策质量整体打分（1-10），什么类型的事你做对了判断，什么类型做错了？\n\n'
          + '### 四、赛道竞争力评估\n- 你所在的行业/岗位是上行赛道、平稳赛道还是下行赛道？\n- 你的不可替代性是增强还是减弱？\n- 你的市场价值（如果今天出去找工作，能拿到的机会和薪资）在什么水平？\n- 35岁/40岁节点逼近的话，你现在的位置够安全吗？\n\n'
          + '### 五、下一年战略规划\n- 基于今年的复盘，下一年最应该聚焦的一个主目标是什么？\n- 下年3个目标的优先级排序是否合理？\n- 下一年最该开始做的一件事和最该停止做的一件事\n- 预测下一年可能出现的3个风险和应对预案\n- 如果下一年你只能完成一件事，哪件事对3年后的你最有价值？\n\n'
          + '### 六、三年视角\n- 把今年放进过去2年和未来3年的5年时间窗：现在处于什么位置？\n- 按目前的轨迹，3年后的你会感谢还是后悔今年的选择？\n- 如果现在的方向持续走3年，最坏的结果是什么？最好的结果是什么？\n\n'
          + '## 规则：诚实、深刻、有前瞻性。不要只给"还不错"、"继续加油"这类评价。如果发现我在逃避什么、自欺什么、或者浪费时间在错的方向上，直接指出来。这是年度复盘，不是年终总结报告——重点不是写了多少而是看到了多少。';
      }

    var prompt = wrapPrompt(raw, '职业复盘', modeName);
    resultBox.classList.remove('loading');
    resultBox.textContent = prompt;
    document.getElementById('review-copy-btn').style.display = 'inline-block';
    saveReviewData();
  }, function(err) {
    document.getElementById('review-result').classList.remove('show');
    showToast(err, true);
  });
}

function saveReviewData() {
  var d = AppState.userData.review || {};
  var ids = ['rv-weekly-date','rv-weekly-top3','rv-weekly-achievement','rv-weekly-setback','rv-weekly-time','rv-weekly-next',
    'rv-monthly-date','rv-monthly-goalrate','rv-monthly-gain','rv-monthly-challenge','rv-monthly-skills','rv-monthly-satisfaction','rv-monthly-next',
    'rv-annual-year','rv-annual-role','rv-annual-top5','rv-annual-lessons','rv-annual-skillgrowth','rv-annual-satisfaction','rv-annual-nextgoals','rv-annual-summary'];
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) d[id] = el.value;
  });
  AppState.userData.review = d;
  saveState();
}

// ============================================================
// 模块6：入职陪跑
// ============================================================
var currentOnboardMode = 'plan';

function initOnboarding() {
  var container = document.getElementById('onboarding-container');
  container.innerHTML = ''
    + '<div class="mode-switch">'
    + '<button class="mode-btn active" id="ob-mode-plan" onclick="switchOnboardMode(\'plan\')">📅 90天融入计划</button>'
    + '<button class="mode-btn" id="ob-mode-risk" onclick="switchOnboardMode(\'risk\')">⚠️ 风险诊断</button>'
	    + '<button class="mode-btn" id="ob-mode-burnout" onclick="switchOnboardMode(\'burnout\')">🥱 倦怠诊断</button>'
    + '<button class="mode-btn" id="ob-mode-mutual" onclick="switchOnboardMode(\'mutual\')">🔄 双向评估</button>'
    + '</div>'
    + '<div id="onboard-tab-content"></div>'
    + '<div class="result-box" id="onboard-result"></div>'
    + '<button class="btn btn-outline" id="onboard-copy-btn" style="display:none;margin-top:8px" onclick="copyResult(\'onboard-result\')">📋 复制指令</button>'
    + '<div class="instruction"><strong>怎么用：</strong>入职前选「90天计划」做规划，入职后遇到问题选「风险诊断」或「倦怠诊断」，感觉不对劲选「双向评估」帮你判断这个公司适不适合你。AI给你系统化的融入方案和决策支撑。</div>';
  switchOnboardMode('plan');
}

function switchOnboardMode(mode) {
  currentOnboardMode = mode;
  document.querySelectorAll('#onboarding-container .mode-btn').forEach(function(b) { b.classList.remove('active'); });
  document.getElementById('ob-mode-' + mode)?.classList.add('active');
  document.getElementById('onboard-result').classList.remove('show');
  document.getElementById('onboard-copy-btn').style.display = 'none';

  var content = document.getElementById('onboard-tab-content');
  var d = AppState.userData.onboarding || {};

  if (mode === 'plan') {
    content.innerHTML = '<div class="card">'
      + '<h3>📅 新岗位90天融入计划</h3>'
      + '<p class="section-note">入职前填写，AI帮你设计系统化的融入方案。信息越详细，计划越精准。</p>'
      + '<div class="form-row-2col">'
      + '<div><label>新公司/岗位</label><input type="text" id="ob-plan-position" placeholder="如：运营VP" value="' + escapeHTML(d.planPosition || '') + '"></div>'
      + '<div><label>公司阶段与规模</label><input type="text" id="ob-plan-stage" placeholder="如：B轮150人 / 上市公司" value="' + escapeHTML(d.planStage || '') + '"></div>'
      + '</div>'
      + '<label>管理的团队情况</label>'
      + '<input type="text" id="ob-plan-team" placeholder="如：管15人，下设3个主管，其中2个是老人" value="' + escapeHTML(d.planTeam || '') + '">'
      + '<label>试用期最需要打赢的3场硬仗</label>'
      + '<textarea id="ob-plan-battles" rows="3" placeholder="1.&#10;2.&#10;3.">' + escapeHTML(d.planBattles || '') + '</textarea>'
      + '<label>公司文化特征（帮你判断融入策略）</label>'
      + '<textarea id="ob-plan-culture" rows="2" placeholder="如：结果导向、扁平化、决策快、加班文化重...">' + escapeHTML(d.planCulture || '') + '</textarea>'
      + '<label>你最担心的融入风险</label>'
      + '<input type="text" id="ob-plan-worry" placeholder="如：担心老团队不服 / 老板期望太高 / 文化不适应" value="' + escapeHTML(d.planWorry || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processOnboard()">📅 生成融入计划指令</button>'
      + '</div>';
  } else if (mode === 'risk') {
    content.innerHTML = '<div class="card">'
      + '<h3>⚠️ 入职风险诊断</h3>'
      + '<p class="section-note">入职后感觉不太对？帮你系统分析是该给时间还是该止损。</p>'
      + '<label>岗位</label><input type="text" id="ob-risk-position" placeholder="如：运营总监" value="' + escapeHTML(d.riskPosition || '') + '">'
      + '<label>已入职多久</label><input type="text" id="ob-risk-time" placeholder="如：第7周（试用期6个月）" value="' + escapeHTML(d.riskTime || '') + '">'
      + '<label>你观察到的具体表现（写事实，不要写感觉）</label>'
      + '<textarea id="ob-risk-obs" rows="5" placeholder="如：&#10;- 前2周很积极，第3周开始不怎么主动汇报了&#10;- 开了3次团队会议，有2次被下属质疑方案&#10;- 上周承诺的客户拜访计划没按时交&#10;- 跟他聊过一次，他说"还不适应这里的节奏"&#10;- 但在行业里的人脉确实带来了2个潜在客户">' + escapeHTML(d.riskObs || '') + '</textarea>'
      + '<label>你内心真正的担忧</label>'
      + '<input type="text" id="ob-risk-worry" placeholder="如：感觉他能力可能不够，但才7周下结论会不会太早？" value="' + escapeHTML(d.riskWorry || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processOnboard()">⚠️ 生成风险诊断指令</button>'
      + '</div>';
  } else if (mode === 'burnout') {
    content.innerHTML = '<div class="card">'
      + '<h3>🥱 职业倦怠诊断</h3>'
      + '<p class="section-note">过了试用期却开始迷茫？帮你识别倦怠信号，判断是该调整心态、换方向还是跳槽。</p>'
      + '<label>当前岗位与入职时间</label><input type="text" id="ob-bo-position" placeholder="如：运营总监，入职8个月（试用期已过）" value="' + escapeHTML(d.boPosition || '') + '">'
      + '<label>你正在经历的倦怠/瓶颈信号（勾选所有符合的）</label>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">'
      + '<label class="bottleneck-check"><input type="checkbox" id="ob-bo-sig-bored"' + (d.boSigBored ? ' checked' : '') + '> 工作重复无聊，缺乏挑战</label>'
      + '<label class="bottleneck-check"><input type="checkbox" id="ob-bo-sig-tired"' + (d.boSigTired ? ' checked' : '') + '> 身心俱疲，精力枯竭</label>'
      + '<label class="bottleneck-check"><input type="checkbox" id="ob-bo-sig-meaning"' + (d.boSigMeaning ? ' checked' : '') + '> 找不到意义感</label>'
      + '<label class="bottleneck-check"><input type="checkbox" id="ob-bo-sig-ceiling"' + (d.boSigCeiling ? ' checked' : '') + '> 看到天花板，晋升无望</label>'
      + '<label class="bottleneck-check"><input type="checkbox" id="ob-bo-sig-relationship"' + (d.boSigRelationship ? ' checked' : '') + '> 人际关系消耗大</label>'
      + '<label class="bottleneck-check"><input type="checkbox" id="ob-bo-sig-growth"' + (d.boSigGrowth ? ' checked' : '') + '> 能力不再成长，吃老本</label>'
      + '<label class="bottleneck-check"><input type="checkbox" id="ob-bo-sig-value"' + (d.boSigValue ? ' checked' : '') + '> 价值观冲突</label>'
      + '<label class="bottleneck-check"><input type="checkbox" id="ob-bo-sig-envy"' + (d.boSigEnvy ? ' checked' : '') + '> 羡慕他人，想逃离</label>'
      + '</div>'
      + '<label>倦怠/瓶颈的具体表现</label>'
      + '<textarea id="ob-bo-detail" rows="4" placeholder="如：&#10;- 每天早上不想起床上班，周日晚上焦虑&#10;- 开会能不说话就不说话，对项目没有热情&#10;- 觉得自己在做的事没有价值">' + escapeHTML(d.boDetail || '') + '</textarea>'
      + '<label>这种状态持续了多久？</label>'
      + '<input type="text" id="ob-bo-duration" placeholder="如：大概3个月了，最近1个月加重了" value="' + escapeHTML(d.boDuration || '') + '">'
      + '<label>你期待的理想状态</label>'
      + '<textarea id="ob-bo-ideal" rows="2" placeholder="如：找到有热情的工作 / 换个部门 / 重新找到工作意义">' + escapeHTML(d.boIdeal || '') + '</textarea>'
      + '<label>目前的应对方式（什么有用？什么没用？）</label>'
      + '<textarea id="ob-bo-coping" rows="2" placeholder="如：试过跟老板聊，但他说调整心态；想跳槽又怕跳进另一个坑">' + escapeHTML(d.boCoping || '') + '</textarea>'
      + '<button class="btn btn-primary btn-lg-full" onclick="processOnboard()">🥱 生成倦怠诊断指令</button>'
      + '</div>';
  } else if (mode === 'mutual') {
    content.innerHTML = '<div class="card">'
      + '<h3>🔄 双向评估：这个公司/岗位适合我吗？</h3>'
      + '<p class="section-note">入职不只是公司在试用你，你也在试用公司。帮你系统性评估这个选择是否正确。</p>'
      + '<label>公司/岗位</label><input type="text" id="ob-mu-position" placeholder="如：运营总监" value="' + escapeHTML(d.muPosition || '') + '">'
      + '<label>已入职多久</label><input type="text" id="ob-mu-time" placeholder="如：第5周（试用期6个月）" value="' + escapeHTML(d.muTime || '') + '">'
      + '<label>入职前的期望（当初为什么选这家公司？）</label>'
      + '<textarea id="ob-mu-expectation" rows="2" placeholder="如：期望更大的平台、期望带更大的团队、期望更高的薪酬、期望学到新技能...">' + escapeHTML(d.muExpectation || '') + '</textarea>'
      + '<label>现在的实际感受 vs 期望（差距在哪里？）</label>'
      + '<textarea id="ob-mu-reality" rows="4" placeholder="如：&#10;- 平台确实大了但要做的跟说的不一样&#10;- 团队比想的弱，老人文化重&#10;- 薪酬达到了但工作内容不喜欢&#10;- 公司方向频繁调整让我不安">' + escapeHTML(d.muReality || '') + '</textarea>'
      + '<label>你对以下维度的满意度（1-10分，用文字描述）</label>'
      + '<textarea id="ob-mu-dimensions" rows="4" placeholder="工作内容：X分 — ...&#10;直接上司：X分 — ...&#10;团队氛围：X分 — ...&#10;公司前景：X分 — ...&#10;成长空间：X分 — ...&#10;薪酬回报：X分 — ...&#10;工作强度：X分 — ...&#10;文化匹配：X分 — ...">' + escapeHTML(d.muDimensions || '') + '</textarea>'
      + '<label>你观察到的红旗信号（不管多小都写）</label>'
      + '<textarea id="ob-mu-redflags" rows="3" placeholder="如：公司刚裁了一轮 / 核心员工最近走了3个 / 老板说的方向和实际做的不一致 / 承诺的资源没到位 / 试用期指标不清晰...">' + escapeHTML(d.muRedflags || '') + '</textarea>'
      + '<label>你看到的好信号</label>'
      + '<textarea id="ob-mu-greensignals" rows="2" placeholder="如：团队成员专业能力强 / 老板愿意放手让我做 / 公司业务增长不错...">' + escapeHTML(d.muGreensignals || '') + '</textarea>'
      + '<label>你还有其他选择吗？</label>'
      + '<input type="text" id="ob-mu-alternatives" placeholder="如：有猎头在联系 / 前公司愿意让我回去 / 暂时没有其他选择" value="' + escapeHTML(d.muAlternatives || '') + '">'
      + '<button class="btn btn-primary btn-lg-full" onclick="processOnboard()">🔄 生成双向评估指令</button>'
      + '</div>';
  }
}

function processOnboard() {
  var resultBox = document.getElementById('onboard-result');
  showSpinner('onboard-result');
  document.getElementById('onboard-copy-btn').style.display = 'none';

  useOneCredit(function() {
    var mode = currentOnboardMode;
    var raw = '';
    var modeName = '';

    if (mode === 'plan') {
      modeName = '90天融入计划';
      var position = document.getElementById('ob-plan-position').value || '【请填写】';
      var stage = document.getElementById('ob-plan-stage').value || '【请填写】';
      var team = document.getElementById('ob-plan-team').value || '【请填写】';
      var battles = document.getElementById('ob-plan-battles').value || '【请填写】';
      var culture = document.getElementById('ob-plan-culture').value || '【请填写】';
      var worry = document.getElementById('ob-plan-worry').value || '无';
      raw = '你是一位资深企业教练，专门帮助中高管成功度过试用期，服务过500+位高管的入职融入辅导。请帮我设计90天融入计划。\n\n'
        + '## 背景\n- 岗位：' + position + '\n- 公司阶段：' + stage + '\n- 团队情况：' + team + '\n- 3场硬仗：\n' + battles + '\n- 文化特征：' + culture + '\n- 最大担忧：' + worry + '\n\n'
        + '## 请按以下框架输出\n\n'
        + '### 一、90天成功定义\n- 这个岗位90天"成功"的具体标准是什么？\n- 什么算"正常"？什么算"超出预期"？什么算"需要关注"？\n\n'
        + '### 二、分阶段行动计划\n'
        + '**第1-30天：了解期（听、看、建关系）**\n- 应该跟谁聊？看什么？学什么？\n- 30天检查点：应该呈现出什么状态？\n- 老板在第1个月应该做什么？\n\n'
        + '**第31-60天：切入期（小胜、立威、定方向）**\n- 第一个突破口选什么？\n- 跟老团队的关系怎么建立？\n- 60天检查点：什么算正常/偏慢？\n\n'
        + '**第61-90天：发力期（推进关键战役、建立节奏）**\n- 3场硬仗的进度评估标准\n- 90天检查点：通过/延长观察/止损的判断标准\n\n'
        + '### 三、融入风险预案\n- 针对"' + worry + '"的具体应对方案\n- 老团队抗拒怎么办？\n- 做事风格跟公司文化冲突怎么办？\n- 前30天"看起来什么都没做"怎么办？\n\n'
        + '### 四、老板行动清单\n- 每周该做什么来支持他？\n- 什么信号该介入？什么信号该放手？\n\n'
        + '## 规则：计划要具体到每周做什么，每个检查点要有客观标准。';

    } else if (mode === 'risk') {
      modeName = '风险诊断';
      var rPos = document.getElementById('ob-risk-position').value || '【请填写】';
      var rTime = document.getElementById('ob-risk-time').value || '【请填写】';
      var rObs = document.getElementById('ob-risk-obs').value || '【请填写】';
      var rWorry = document.getElementById('ob-risk-worry').value || '【请填写】';
      raw = '你是一位资深企业教练，专门帮老板处理高管试用期的疑难问题。请帮我做一次风险诊断。\n\n'
        + '## 情况\n- 岗位：' + rPos + '\n- 已入职：' + rTime + '\n- 观察到的表现：\n' + rObs + '\n- 我的担忧：' + rWorry + '\n\n'
        + '## 请按以下框架输出\n\n'
        + '### 一、表现评估\n- 哪些表现是正常的？（新环境适应期）\n- 哪些需要警惕？\n- 哪些说明这个人可能根本不行？\n- 区分"水土不服"和"能力不足"\n\n'
        + '### 二、问题诊断\n问题出在哪一层？\n- 能力问题：他真的不会？\n- 意愿问题：他不想干？\n- 环境问题：公司给他的条件不够？\n- 期望问题：老板期望跟他理解差距太大？\n- 文化问题：做事方式冲突？\n\n'
        + '### 三、止损决策框架\n- 现在是该"继续观察"还是"果断止损"？\n- 如果继续观察：看到什么时候必须做决定？观察什么信号？\n- 如果止损：最佳时机？怎么操作损失最小？\n- 评估沉没成本——不要因为"已经花了时间和钱"而继续错下去\n\n'
        + '### 四、行动建议\n- 基于诊断的具体行动方案\n- 接下来4周该做什么？\n- 怎么跟他谈？谈什么？\n\n'
        + '## 规则：诚实但不要轻易下结论，也不要无限拖延。如果我的直觉跟事实一致就告诉我，如果不一致也告诉我。';
    } else if (mode === 'burnout') {
      modeName = '倦怠诊断';
      var boPos = document.getElementById('ob-bo-position').value || '【请填写】';
      var boDuration = document.getElementById('ob-bo-duration').value || '【未填】';
      var boDetail = document.getElementById('ob-bo-detail').value || '【请填写】';
      var boIdeal = document.getElementById('ob-bo-ideal').value || '【未填】';
      var boCoping = document.getElementById('ob-bo-coping').value || '【未填】';
      var boSignals = [];
      if (document.getElementById('ob-bo-sig-bored')?.checked) boSignals.push('工作重复无聊缺乏挑战');
      if (document.getElementById('ob-bo-sig-tired')?.checked) boSignals.push('身心俱疲精力枯竭');
      if (document.getElementById('ob-bo-sig-meaning')?.checked) boSignals.push('找不到意义感');
      if (document.getElementById('ob-bo-sig-ceiling')?.checked) boSignals.push('看到天花板晋升无望');
      if (document.getElementById('ob-bo-sig-relationship')?.checked) boSignals.push('人际关系消耗大');
      if (document.getElementById('ob-bo-sig-growth')?.checked) boSignals.push('能力不再成长吃老本');
      if (document.getElementById('ob-bo-sig-value')?.checked) boSignals.push('价值观冲突');
      if (document.getElementById('ob-bo-sig-envy')?.checked) boSignals.push('羡慕他人想逃离');
      raw = '你是一位资深职业心理咨询师兼生涯规划师，专门帮助职场人度过倦怠期和职业瓶颈期。请帮我做一次深度的职业倦怠诊断。\n\n'
        + '## 基本情况\n- 岗位与入职时间：' + boPos + '\n- 倦怠持续时长：' + boDuration + '\n- 已识别的信号：' + (boSignals.length > 0 ? boSignals.join('、') : '未勾选') + '\n\n'
        + '## 具体表现\n' + boDetail + '\n\n'
        + '## 期望状态\n' + boIdeal + '\n\n'
        + '## 已尝试的应对\n' + boCoping + '\n\n'
        + '## 请按以下框架进行诊断\n\n'
        + '### 一、倦怠类型判断\n根据信号判断这是哪种倦怠：\n'
        + '- 能力型倦怠：工作太简单，吃老本→无聊\n'
        + '- 压力型倦怠：工作太难/太重→耗竭\n'
        + '- 意义型倦怠：工作跟价值观不符→空虚\n'
        + '- 瓶颈型倦怠：看到头了→绝望\n'
        + '- 关系型倦怠：人际消耗→心力交瘁\n'
        + '通常是多种混合，请给出主要类型和次要类型。\n\n'
        + '### 二、根源分析\n- 倦怠的根本原因是能力问题、意愿问题、环境问题还是方向问题？\n'
        + '- 哪些是客观情况（行业大环境、公司阶段、岗位特性），哪些是主观感受？\n'
        + '- 如果换掉当前环境（跳槽/转岗），这些问题还会重现吗？\n\n'
        + '### 三、倦怠阶段评估\n- 现在是早期（可以通过调整恢复）、中期（需要结构性改变）还是晚期（职业认同崩塌）？\n'
        + '- 继续这样下去，1年后的你会是什么状态？\n\n'
        + '### 四、应对方案矩阵\n给出三类方案供我选择：\n'
        + '**方案A：优化现状（调整自己）**\n'
        + '- 有什么小改变可以带来大不同？\n'
        + '- 怎么重新定义工作的意义？\n'
        + '- 怎么在有瓶颈的情况下保持核心竞争力？\n\n'
        + '**方案B：结构改变（调整环境）**\n'
        + '- 内部转岗/调部门可行吗？\n'
        + '- 怎么跟上司/HR做一次建设性的职业谈话？\n'
        + '- 是否可以用副业/项目来填补主业缺的意义感？\n\n'
        + '**方案C：跳脱重建（跳槽/转行/创业）**\n'
        + '- 现在跳槽的时机是否合适？\n'
        + '- 如果转行，怎么用最小成本试错？\n'
        + '- 怎么避免"从这个坑跳进那个坑"？\n\n'
        + '### 五、止损与行动建议\n- 哪种方案最适合我目前的状态和阶段？\n'
        + '- 接下来的4周，建议我做哪3件事？\n'
        + '- 什么信号出现说明"该果断跳槽了"？\n'
        + '- 什么信号出现说明"再给现在的工作一个机会"？\n\n'
        + '## 规则：不要泛泛地说"加油"、"熬过去就好了"。给我可执行的方案，如果是该止损了就直说。同时保护好我的心理——不要让我觉得"我是不是废了"。倦怠不是能力问题，是信号，说明有什么需要改变。';
    } else if (mode === 'mutual') {
      modeName = '双向评估';
      var muPos = document.getElementById('ob-mu-position').value || '【请填写】';
      var muTime = document.getElementById('ob-mu-time').value || '【请填写】';
      var muExpect = document.getElementById('ob-mu-expectation').value || '【请填写】';
      var muReality = document.getElementById('ob-mu-reality').value || '【请填写】';
      var muDims = document.getElementById('ob-mu-dimensions').value || '【请填写】';
      var muRed = document.getElementById('ob-mu-redflags').value || '无';
      var muGreen = document.getElementById('ob-mu-greensignals').value || '无';
      var muAlt = document.getElementById('ob-mu-alternatives').value || '【请填写】';
      raw = '你是一位资深职业决策顾问，帮助过3000+人评估工作选择的正确性。请帮我做入职后的双向评估：公司是否适合我？\n\n'
        + '## 基本情况\n- 公司/岗位：' + muPos + '\n- 已入职：' + muTime + '\n\n'
        + '## 入职前期望\n' + muExpect + '\n\n'
        + '## 实际感受与差距\n' + muReality + '\n\n'
        + '## 各维度满意度\n' + muDims + '\n\n'
        + '## 观察信号\n- 红旗信号（危险）：' + muRed + '\n- 好信号（积极）：' + muGreen + '\n\n'
        + '## 其他选择\n' + muAlt + '\n\n'
        + '## 请按以下框架评估\n\n'
        + '### 一、匹配度诊断\n- 根据各维度满意度，我与这个公司/岗位的总体匹配度是多少？\n- 哪些不匹配是"适应期正常现象"？哪些是"结构性不匹配"？\n- 区分"临时的不适应"和"本质的不合适"——前者可以调整，后者越拖越痛苦\n\n'
        + '### 二、红旗信号分析\n- 我看到的红旗信号有多严重？\n- 哪些是"绝对红线"（必须离开的信号）？\n- 哪些是"黄灯"（值得警惕但可以再观察）？\n- 有没有我没有注意到的隐藏红旗？\n\n'
        + '### 三、好信号对照\n- 积极信号是否足以抵消红旗？\n- 是我对坏信号过度敏感，还是对好信号过度乐观？\n\n'
        + '### 四、决策矩阵\n从以下维度给"留下"和"离开"两个选项打分（每项1-5分）：\n- 能力成长 | 薪酬回报 | 职位提升 | 行业前景 | 心理状态 | 生活质量 | 人脉积累 | 长期价值\n\n'
        + '### 五、行动建议\n- 综合评分，建议留下、继续观察还是准备离开？\n- 如果留下：接下来30天应该观察什么？改变什么？\n- 如果离开：最佳时机？怎么离开？（裸辞有巨大成本）\n- 如果有其他选择（' + muAlt + '），横向对比\n- 什么时间点必须做决定？（设定决策deadline）\n\n'
        + '### 六、止损框架\n- 什么信号出现说明"不能再等了"？\n- 如果现在离开，最坏的结果是什么？最好的结果是什么？\n- 如果再留6个月，最坏的结果是什么？最好的结果是什么？\n\n'
        + '## 规则：不替我做决定，但帮我看清每一个维度的真实情况。不要因为"换工作不好看"而让我坚持一个错误的决定，也不要因为一时不舒服而让我放弃一个好机会。';

    }

    var prompt = wrapPrompt(raw, '入职陪跑', modeName);
    resultBox.classList.remove('loading');
    resultBox.textContent = prompt;
    document.getElementById('onboard-copy-btn').style.display = 'inline-block';
    saveOnboardData();
  }, function(err) {
    document.getElementById('onboard-result').classList.remove('show');
    showToast(err, true);
  });
}

function saveOnboardData() {
  var d = AppState.userData.onboarding || {};
  var ids = ['ob-plan-position','ob-plan-stage','ob-plan-team','ob-plan-battles','ob-plan-culture','ob-plan-worry',
    'ob-risk-position','ob-risk-time','ob-risk-obs','ob-risk-worry',
    'ob-bo-position','ob-bo-duration','ob-bo-detail','ob-bo-ideal','ob-bo-coping',
    'ob-bo-sig-bored','ob-bo-sig-tired','ob-bo-sig-meaning','ob-bo-sig-ceiling','ob-bo-sig-relationship','ob-bo-sig-growth','ob-bo-sig-value','ob-bo-sig-envy',
    'ob-mu-position','ob-mu-time','ob-mu-expectation','ob-mu-reality','ob-mu-dimensions','ob-mu-redflags','ob-mu-greensignals','ob-mu-alternatives'];
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') d[id] = el.checked;
    else d[id] = el.value;
  });
  AppState.userData.onboarding = d;
  saveState();
}

// ============================================================
// 通用
// ============================================================
function escapeHTML(str) {
  var div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function showToast(msg, warn) {
  var t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = 'toast' + (warn ? ' warn' : '') + ' show';
  setTimeout(function() { t.classList.remove('show'); }, 2500);
}

document.addEventListener('DOMContentLoaded', function() {
  loadState();
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
          currentSession = { code: lastCode, userName: validation.userName, expiry: validation.expiry, maxUses: validation.maxUses, maxWechatUsers: validation.maxWechatUsers, storageKey: storageKey };
          _appGuard.authorize();
  enterApp();
          bindNavEvents();
          return;
        }
      }
    }
  }
  document.getElementById('loginScreen').style.display = '';
  bindNavEvents();
});

function bindNavEvents() {
  document.querySelectorAll('.nav-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var mod = item.dataset.module;
      if (mod) navTo(mod);
    });
  });
}

// Console 防绕过陷阱：覆盖 window.enterApp 为空操作
// 内部代码通过作用域链调用真正的 enterApp 函数声明，不受影响
window.enterApp = function() {
  /* 请通过正常的激活流程使用 */
};
