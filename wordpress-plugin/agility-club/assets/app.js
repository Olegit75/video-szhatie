/* Аджилити-клуб: интерфейс страницы. Данные и права — на сервере (REST API плагина). */
(function () {
  "use strict";
  var CFG = window.ACL || {};
  var root = document.getElementById("acl-app");
  if (!root) return;

  var S = null;               // состояние с сервера
  var tab = (location.hash || "").slice(1) || "schedule";
  var busy = false;

  var TABS = {
    guest:   [["schedule", "Расписание"], ["news", "Новости"], ["video", "Видео"]],
    pending: [["schedule", "Расписание"], ["profile", "Кто вы?"], ["news", "Новости"], ["video", "Видео"]],
    member:  [["schedule", "Расписание"], ["mine", "Мои тренировки"], ["news", "Новости"], ["video", "Видео"]],
    admin:   [["schedule", "Расписание"], ["sessions", "Тренировки и оплаты"], ["debts", "Расчёты"], ["news", "Новости"], ["video", "Видео"], ["settings", "Настройки"]]
  };
  var ROLE = { guest: "", pending: "Ждёт подтверждения", member: "Участник", admin: "Администратор" };
  var HOURS = [1, 1.5, 2, 2.5, 3, 3.5, 4];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function rub(v) { return v == null || !isFinite(v) ? "—" : Math.round(v).toLocaleString("ru-RU") + " ₽"; }
  function fmtDate(s) { if (!s) return ""; var p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString("ru-RU", { day: "numeric", month: "short", weekday: "short" }); }
  function q(sel) { return root.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }
  function memberName(id) { var m = (S.members || []).filter(function (x) { return x.id === id; })[0]; return m ? m.name : "?"; }
  function org() { return (S.members || []).filter(function (m) { return m.is_organizer; })[0] || null; }
  function regular() { return (S.members || []).filter(function (m) { return !m.is_organizer; }); }
  function nextMark(cur) { return cur === "" ? "Да" : cur === "debt" ? "О" : ""; }
  function markLabel(st) { return st === "paid" ? "О" : st === "debt" ? "Да" : ""; }

  /* ---------- сервер ---------- */
  function api(path, method, body) {
    return fetch(CFG.api + path, {
      method: method || "GET",
      credentials: "same-origin",
      headers: { "X-WP-Nonce": CFG.nonce, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.message) || "Ошибка сервера");
        return j;
      });
    });
  }
  function act(path, method, body) {
    busy = true;
    return api(path, method, body).then(function (st) { S = st; busy = false; render(); return st; })
      .catch(function (e) { busy = false; toast(e.message || "Не сохранилось. Попробуйте ещё раз."); render(); throw e; });
  }
  function toast(msg) {
    var el = document.getElementById("acl-toast");
    if (!el) { el = document.createElement("div"); el.id = "acl-toast"; el.className = "toast"; el.setAttribute("role", "status"); root.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { el.hidden = true; }, 4500);
  }

  /* ---------- каркас ---------- */
  function render() {
    if (!S) return;
    var tabs = TABS[S.role] || TABS.guest;
    if (!tabs.some(function (t) { return t[0] === tab; })) tab = "schedule";
    var L = S.links || {};
    var auth = S.user
      ? '<span>' + esc(S.user) + (ROLE[S.role] ? ' · <span class="role">' + ROLE[S.role] + "</span>" : "") + '</span><a href="' + esc(L.logout) + '">Выйти</a>'
      : '<a href="' + esc(L.login) + '">Войти</a>' + (L.register ? '<a href="' + esc(L.register) + '">Регистрация</a>' : "");
    root.innerHTML =
      '<header><div class="wrap"><div class="brand"><span class="pole" aria-hidden="true"></span>' + esc(CFG.site || "Аджилити-клуб") + "</div>" +
      '<nav aria-label="Разделы">' + tabs.map(function (t) { return '<button type="button" data-tab="' + t[0] + '" aria-current="' + (t[0] === tab) + '">' + t[1] + "</button>"; }).join("") + "</nav>" +
      '<div class="who-am-i">' + auth + "</div></div></header>" +
      '<main><div class="wrap" id="acl-view"></div></main>';
    qa("nav button").forEach(function (b) {
      b.addEventListener("click", function () { tab = b.dataset.tab; if (tab === "video") openDate = null; try { history.replaceState(null, "", "#" + tab); } catch (e) {} render(); window.scrollTo(0, 0); refresh(); });
    });
    var v = q("#acl-view");
    ({ schedule: viewSchedule, profile: viewProfile, mine: viewMine, sessions: viewSessions, debts: viewDebts, news: viewNews, video: viewVideo, settings: viewSettings }[tab])(v);
  }

  /* ---------- Расписание ---------- */
  function upcoming() {
    return (S.sessions || []).filter(function (s) { return s.date >= S.today; })
      .sort(function (a, b) { return (a.date + a.start).localeCompare(b.date + b.start); });
  }
  function viewSchedule(v) {
    var up = upcoming(), r = S.role, o = org();
    var cards = up.map(function (s) {
      var extra = "";
      if (r === "member" || r === "admin") {
        var names = (s.org_in && o ? [o.name] : []).concat((s.att || []).map(memberName));
        extra = '<div class="who">' + (names.length ? "Записаны: " + esc(names.join(", ")) : "Пока никто не записался") + "</div>" +
          '<div class="who">С участника сейчас: <b>' + rub(s.per) + "</b></div>";
        if (r === "member") {
          extra += '<div><button type="button" class="btn small ' + (s.my ? "ghost" : "") + '" data-join="' + s.id + '">' + (s.my ? "Отменить запись" : "Записаться") + "</button></div>";
        }
      }
      return '<article class="slot"><div class="d">' + esc(fmtDate(s.date)) + '</div><div class="t">' + esc(s.start || "время уточняется") + " · " + esc(s.hours) + " ч</div>" + extra + "</article>";
    }).join("");
    var hint = r === "guest" ? "Чтобы записываться и видеть стоимость, войдите или зарегистрируйтесь." : r === "pending" ? "Выберите себя на вкладке «Кто вы?» — после подтверждения сможете записываться." : "";
    v.innerHTML = '<div><h1>Ближайшие тренировки</h1>' + (hint ? '<p class="lead">' + hint + "</p>" : "") + "</div>" +
      (up.length ? '<div class="cards">' + cards + "</div>" : '<div class="panel empty">Новых тренировок пока нет.</div>') +
      (S.news && S.news[0] ? '<div class="panel"><h2>Последняя новость</h2>' + postHtml(S.news[0]) + "</div>" : "");
    qa("button[data-join]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = S.sessions.filter(function (x) { return String(x.id) === b.dataset.join; })[0];
        if (s.my === "paid") { toast("Эта тренировка уже оплачена. Изменить можно во вкладке «Мои тренировки»."); return; }
        b.disabled = true;
        act("/mark", "POST", { session_id: s.id, member_id: S.me.id, mark: s.my ? "" : "Да" }).catch(function () {});
      });
    });
  }

  /* ---------- Кто вы? (аккаунт без привязки) ---------- */
  function viewProfile(v) {
    var req = S.request ? (S.members || []).filter(function (m) { return m.id === S.request; })[0] : null;
    v.innerHTML = '<div><h1>Кто вы?</h1><p class="lead">Выберите себя в списке участников. Администратор подтвердит, и вы сможете записываться, видеть стоимость и отмечать оплату.</p></div>' +
      ((S.members || []).length
        ? '<form class="panel row" id="acl-req"><label for="acl-req-sel">Участник<select id="acl-req-sel">' +
          S.members.map(function (m) { return '<option value="' + m.id + '"' + (req && req.id === m.id ? " selected" : "") + ">" + esc(m.name) + "</option>"; }).join("") +
          '</select></label><button class="btn">' + (req ? "Изменить выбор" : "Отправить") + "</button></form>"
        : '<div class="panel empty">Свободных имён в списке нет. Попросите администратора добавить вас.</div>') +
      (req ? '<div class="panel"><span class="pill warn">Ждёт подтверждения</span> Вы выбрали: <b>' + esc(req.name) + "</b></div>" : "");
    var f = q("#acl-req");
    if (f) f.addEventListener("submit", function (e) { e.preventDefault(); act("/request", "POST", { member_id: +q("#acl-req-sel").value }).then(function () { toast("Заявка отправлена администратору."); }, function () {}); });
  }

  /* ---------- Мои тренировки ---------- */
  function viewMine(v) {
    var list = (S.sessions || []).slice().sort(function (a, b) { return (b.date + b.start).localeCompare(a.date + a.start); });
    var debt = 0, paid = 0;
    var rows = list.map(function (s) {
      if (s.date <= S.today && s.per != null) { if (s.my === "paid") paid += s.per; if (s.my === "debt") debt += s.per; }
      return '<tr class="' + (s.date >= S.today ? "future" : "") + '"><td class="l">' + esc(fmtDate(s.date)) + '</td><td class="num">' + esc(s.start) + '</td><td class="num">' + esc(s.hours) + '</td><td class="num">' + s.shares + '</td><td class="money">' + (s.my ? rub(s.per) : "—") + "</td>" +
        '<td><button type="button" class="mark ' + s.my + '" data-s="' + s.id + '" aria-label="' + (s.my === "paid" ? "оплатил" : s.my === "debt" ? "участвую, не оплатил" : "не записан") + '">' + markLabel(s.my) + "</button></td></tr>";
    }).join("");
    v.innerHTML = "<div><h1>Мои тренировки · " + esc(S.me.name) + '</h1><p class="lead">Нажмите на ячейку: пусто → «Да» (участвую) → «О» (оплатил) → пусто. Сумма пересчитывается, когда кто-то записывается или отменяет запись.</p></div>' +
      '<div class="kpis"><div class="kpi"><b style="color:' + (debt > 0.5 ? "var(--debt)" : "var(--paid)") + '">' + rub(debt) + '</b><span>к оплате за прошедшие</span></div><div class="kpi"><b>' + rub(paid) + "</b><span>оплачено</span></div></div>" +
      (list.length ? '<div class="scroll"><table><thead><tr><th class="l">Дата</th><th>Начало</th><th>Часы</th><th>Долей</th><th>Моя сумма</th><th>Отметка</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : '<div class="panel empty">Тренировок пока нет.</div>');
    qa("button.mark[data-s]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (busy) return;
        var s = S.sessions.filter(function (x) { return String(x.id) === b.dataset.s; })[0];
        b.classList.add("busy");
        act("/mark", "POST", { session_id: s.id, member_id: S.me.id, mark: nextMark(s.my) }).catch(function () {});
      });
    });
  }

  /* ---------- Тренировки и оплаты (админ) ---------- */
  function hoursSelect(id, val, attr) {
    return '<select ' + attr + '="' + id + '" aria-label="Часы">' + HOURS.map(function (h) { return "<option" + (+val === h ? " selected" : "") + ">" + h + "</option>"; }).join("") + "</select>";
  }
  function viewSessions(v) {
    var o = org(), mem = regular(), st = S.settings;
    var list = (S.sessions || []).slice().sort(function (a, b) { return (b.date + b.start).localeCompare(a.date + a.start); });
    var linked = {};
    (S.members || []).forEach(function (m) { if (m.user_id) linked[m.id] = true; });
    var head = '<tr><th class="l">Дата</th><th>Начало</th><th>Часы</th>' + (o ? '<th title="' + st.org_shares + " доли, скидка " + st.org_discount + ' ₽">' + esc(o.name) + "</th>" : "") +
      mem.map(function (m) { return "<th>" + esc(m.name) + (linked[m.id] ? " ●" : "") + "</th>"; }).join("") +
      "<th>Долей</th><th>Аренда</th><th>С участника</th>" + (o ? "<th>" + esc(o.name) + "</th>" : "") + "<th>Мин/собаку</th><th></th></tr>";
    var rows = list.map(function (s) {
      var mk = s.marks || {};
      var cells = mem.map(function (m) {
        var x = mk[m.id] || "";
        return '<td><button type="button" class="mark ' + x + '" data-s="' + s.id + '" data-m="' + m.id + '" aria-label="' + esc(m.name) + '">' + markLabel(x) + "</button></td>";
      }).join("");
      return '<tr class="' + (s.date >= S.today ? "future" : "") + '"><td class="l">' + esc(fmtDate(s.date)) + '</td><td class="num">' + esc(s.start) + "</td><td>" + hoursSelect(s.id, s.hours, "data-hours") + "</td>" +
        (o ? '<td><button type="button" class="mark ' + (s.org_in ? "org" : "") + '" data-s="' + s.id + '" data-m="' + o.id + '" data-org="1" aria-label="' + esc(o.name) + '">' + (s.org_in ? "✓" : "") + "</button></td>" : "") + cells +
        '<td class="num">' + s.shares + '</td><td class="num">' + rub(s.rent) + '</td><td class="money">' + rub(s.per) + "</td>" + (o ? '<td class="num">' + (s.org_in ? rub(s.org) : "—") + "</td>" : "") +
        '<td class="num">' + (s.per_dog == null ? "—" : Math.round(s.per_dog)) + '</td><td><button type="button" class="btn small danger" data-del="' + s.id + '">Удалить</button></td></tr>';
    }).join("");
    v.innerHTML = '<div><h1>Тренировки и оплаты</h1><p class="lead">Нажмите на ячейку, чтобы сменить отметку: пусто → «Да» → «О» → пусто. Точкой ● отмечены участники с доступом: они и сами ставят себе отметки.</p></div>' +
      '<div class="legend"><span><span class="mark paid">О</span> оплатил</span><span><span class="mark debt">Да</span> был, долг</span>' + (o ? '<span><span class="mark org">✓</span> ' + esc(o.name) + " на тренировке (" + st.org_shares + " доли)</span>" : "") + "</div>" +
      '<form class="panel row" id="acl-add"><label for="acl-d">Дата<input type="date" id="acl-d" required></label><label for="acl-t">Начало<input type="time" id="acl-t" value="19:00"></label><label for="acl-h">Часы' + hoursSelect("", 2, "id").replace('id=""', 'id="acl-h"') + '</label><button class="btn">Добавить тренировку</button></form>' +
      (list.length ? '<div class="scroll"><table><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>" : '<div class="panel empty">Тренировок пока нет. Добавьте первую формой выше.</div>') +
      '<p class="note">Аренда = (часы − ' + st.free_hours + ") × " + st.rate + " ₽. " + (o ? "Доля " + esc(o.name) + " = аренда ÷ долей × " + st.org_shares + " − " + st.org_discount + " ₽. " : "") +
      "Остаток делится поровну между отмеченными участниками. Свободное время = часы × 60 − " + (st.setup_min + st.cleanup_min) + " мин, делится на число долей.</p>";
    q("#acl-add").addEventListener("submit", function (e) {
      e.preventDefault();
      act("/sessions", "POST", { date: q("#acl-d").value, start: q("#acl-t").value, hours: +q("#acl-h").value }).then(function () { toast("Тренировка добавлена."); }, function () {});
    });
    qa("button.mark[data-m]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (busy) return;
        var s = S.sessions.filter(function (x) { return String(x.id) === b.dataset.s; })[0];
        var cur = b.dataset.org ? (s.org_in ? "debt" : "") : ((s.marks || {})[b.dataset.m] || "");
        var next = b.dataset.org ? (s.org_in ? "" : "Да") : nextMark(cur);
        b.classList.add("busy");
        act("/mark", "POST", { session_id: s.id, member_id: +b.dataset.m, mark: next }).catch(function () {});
      });
    });
    qa("select[data-hours]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var s = S.sessions.filter(function (x) { return String(x.id) === sel.dataset.hours; })[0];
        act("/sessions", "POST", { id: s.id, date: s.date, start: s.start, hours: +sel.value }).catch(function () {});
      });
    });
    armDelete("del", function (id) { return act("/sessions/" + id, "DELETE"); });
  }

  /* ---------- Расчёты (админ) ---------- */
  function viewDebts(v) {
    var per = {}, rent = 0, paidT = 0, debtT = 0, orgT = 0;
    regular().forEach(function (m) { per[m.id] = { m: m, visits: 0, paid: 0, debt: 0, dates: [] }; });
    (S.sessions || []).filter(function (s) { return s.date <= S.today; }).forEach(function (s) {
      rent += s.rent; if (s.org_in) orgT += s.org;
      Object.keys(s.marks || {}).forEach(function (mid) {
        var p = per[mid], st = s.marks[mid];
        if (!p || s.per == null) return;
        p.visits++;
        if (st === "paid") { p.paid += s.per; paidT += s.per; } else { p.debt += s.per; debtT += s.per; p.dates.push(fmtDate(s.date)); }
      });
    });
    var rows = Object.keys(per).map(function (k) { return per[k]; }).filter(function (p) { return p.visits; })
      .sort(function (a, b) { return b.debt - a.debt; })
      .map(function (p) {
        return '<tr><td class="l">' + esc(p.m.name) + '</td><td class="num">' + p.visits + '</td><td class="num">' + rub(p.paid) + "</td><td>" +
          (p.debt > 0.5 ? '<span class="pill warn">' + rub(p.debt) + "</span>" : '<span class="pill ok">нет долга</span>') + '</td><td class="l wrapcell">' + esc(p.dates.join(", ")) + "</td></tr>";
      }).join("");
    var o = org();
    v.innerHTML = '<div><h1>Расчёты</h1><p class="lead">Итоги по прошедшим тренировкам. «Да» считается долгом, «О» — оплатой.</p></div>' +
      '<div class="kpis"><div class="kpi"><b>' + rub(rent) + '</b><span>аренда, всего</span></div><div class="kpi"><b>' + rub(paidT) + '</b><span>оплачено участниками</span></div>' +
      '<div class="kpi"><b style="color:var(--debt)">' + rub(debtT) + '</b><span>долги участников</span></div>' + (o ? '<div class="kpi"><b>' + rub(orgT) + "</b><span>доля " + esc(o.name) + "</span></div>" : "") + "</div>" +
      (rows ? '<div class="scroll"><table><thead><tr><th class="l">Участник</th><th>Тренировок</th><th>Оплачено</th><th>Долг</th><th class="l">Неоплаченные даты</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : '<div class="panel empty">Прошедших тренировок с участниками пока нет.</div>');
  }

  /* ---------- Новости ---------- */
  function postHtml(p) {
    return '<div class="post"><time>' + esc(fmtDate(p.date)) + "</time><h3>" + esc(p.title) + '</h3><div class="body">' + p.html + "</div></div>"; // html очищен на сервере (wp_kses_post)
  }
  function viewNews(v) {
    var L = S.links || {};
    v.innerHTML = '<div class="row" style="justify-content:space-between"><h1>Новости клуба</h1>' + (L.newPost ? '<a class="btn" href="' + esc(L.newPost) + '">Написать новость</a>' : "") + "</div>" +
      '<div class="panel">' + ((S.news || []).length ? S.news.map(postHtml).join("") : '<div class="empty">Новостей пока нет.</div>') + "</div>";
  }

  /* ---------- Видео ---------- */
  function mb(b) { return b ? (b / 1048576).toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + " МБ" : ""; }
  var onlyMine = false;
  try { onlyMine = localStorage.getItem("acl-only-mine") === "1"; } catch (e) {}

  var openDate = null; // выбранный день на вкладке «Видео»
  try { var hm = /^#video-(\d{4}-\d{2}-\d{2})$/.exec(location.hash); if (hm) { openDate = hm[1]; tab = "video"; } } catch (e) {}

  function setVideoDate(d) {
    openDate = d;
    try { history.replaceState(null, "", d ? "#video-" + d : "#video"); } catch (e) {}
    render();
    window.scrollTo(0, 0);
  }

  function videoItem(x, a, logged) {
    var local = +x.local === 1;
    var media = local
      ? '<video controls preload="metadata" playsinline src="' + esc(x.url) + '" style="width:100%;max-height:70vh;border-radius:8px;background:#000"></video>'
      : '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">Открыть видео</a>';
    var tagged = (x.tagged || []).length ? '<div class="status">На видео: ' + esc(x.tagged.join(", ")) + "</div>" : "";
    var actions = (logged ? '<button type="button" class="btn small ' + (x.mine ? "" : "ghost") + '" data-me="' + x.id + '" aria-pressed="' + (x.mine ? "true" : "false") + '">' + (x.mine ? "✓ Это я" : "Это я") + "</button>" : "") +
      (a ? '<button type="button" class="btn small danger" data-dv="' + x.id + '">Удалить</button>' : "");
    return '<div class="post"><h3>' + esc(x.title) + (x.size ? ' <span class="status">' + mb(+x.size) + "</span>" : "") + "</h3>" + media + tagged +
      (actions ? '<div class="row" style="gap:8px">' + actions + "</div>" : "") + "</div>";
  }

  function viewVideo(v) {
    var a = S.role === "admin";
    var logged = !!S.user;
    var all = S.videos || [];
    var mineCount = all.filter(function (x) { return x.mine; }).length;
    var shown = logged && onlyMine ? all.filter(function (x) { return x.mine; }) : all;
    var byDate = {};
    shown.forEach(function (x) { (byDate[x.date] = byDate[x.date] || []).push(x); });
    var dates = Object.keys(byDate).sort().reverse();
    if (openDate && !byDate[openDate]) openDate = null;

    var filter = logged
      ? '<div class="row" style="gap:8px" role="group" aria-label="Какие видео показать">' +
        '<button type="button" class="btn small ' + (onlyMine ? "ghost" : "") + '" data-filter="all">Все видео (' + all.length + ")</button>" +
        '<button type="button" class="btn small ' + (onlyMine ? "" : "ghost") + '" data-filter="mine">Только мои (' + mineCount + ")</button></div>"
      : "";
    var lead = a ? "Видео загружаются с телефона приложением «Сжатие видео». Ссылку на ролик в ВК или Rutube можно добавить и вручную."
      : logged ? "Нажмите «Это я» под своими роликами — потом их легко найти кнопкой «Только мои»."
      : "Записи тренировок по дням. Войдите, чтобы отмечать свои видео.";
    var html;

    if (openDate) {
      // ---- один день
      var list = byDate[openDate], total = 0;
      list.forEach(function (x) { total += +x.size || 0; });
      html = '<div class="row" style="gap:8px;align-items:center"><button type="button" class="btn small ghost" data-back="1">← Все дни</button></div>' +
        '<div class="row" style="justify-content:space-between;align-items:center"><h1>' + esc(fmtDate(openDate)) + '</h1>' +
        (a && !onlyMine ? '<button type="button" class="btn small danger" data-dday="' + openDate + '">Удалить весь день</button>' : "") + "</div>" +
        '<p class="lead">' + list.length + " видео" + (total ? " · " + mb(total) : "") + (onlyMine ? " · только мои" : "") + "</p>" + filter +
        '<section class="panel">' + list.map(function (x) { return videoItem(x, a, logged); }).join("") + "</section>";
    } else {
      // ---- список дней
      var months = {};
      dates.forEach(function (d) { (months[d.slice(0, 7)] = months[d.slice(0, 7)] || []).push(d); });
      var cards = Object.keys(months).sort().reverse().map(function (m) {
        var p = m.split("-");
        var title = new Date(+p[0], +p[1] - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
        return "<h2 style=\"text-transform:capitalize\">" + esc(title) + '</h2><div class="cards">' + months[m].map(function (d) {
          var list = byDate[d], total = 0, mine = 0;
          list.forEach(function (x) { total += +x.size || 0; if (x.mine) mine++; });
          return '<button type="button" class="slot" data-day="' + d + '" style="text-align:left;cursor:pointer;font:inherit;color:inherit">' +
            '<span class="d">' + esc(fmtDate(d)) + "</span>" +
            '<span class="t">' + list.length + " видео" + (total ? " · " + mb(total) : "") + "</span>" +
            (logged && mine ? '<span class="pill ok" style="justify-self:start">мои: ' + mine + "</span>" : "") + "</button>";
        }).join("") + "</div>";
      }).join("");
      var empty = logged && onlyMine
        ? '<div class="panel empty">Вы ещё не отметили себя ни на одном видео. Откройте день и нажмите «Это я» под роликом, где вы с собакой.</div>'
        : '<div class="panel empty">Видео пока нет.</div>';
      html = '<div><h1>Видео тренировок</h1><p class="lead">' + lead + "</p></div>" + filter +
        (a ? '<details class="panel"><summary style="cursor:pointer">Добавить ссылку вручную</summary><form class="row" id="acl-vf" style="margin-top:12px"><label for="acl-vd">Дата<input type="date" id="acl-vd" value="' + S.today + '"></label><label for="acl-vt" style="flex:1;min-width:180px">Название<input id="acl-vt" required placeholder="Слалом, Дейзи"></label><label for="acl-vu" style="flex:2;min-width:220px">Ссылка<input id="acl-vu" type="url" required placeholder="https://vkvideo.ru/..."></label><button class="btn">Добавить</button></form></details>' : "") +
        (cards || empty);
    }
    v.innerHTML = html;

    var f = q("#acl-vf");
    if (f) f.addEventListener("submit", function (e) { e.preventDefault(); act("/videos", "POST", { date: q("#acl-vd").value, title: q("#acl-vt").value, url: q("#acl-vu").value }).catch(function () {}); });
    qa("button[data-day]").forEach(function (b) { b.addEventListener("click", function () { setVideoDate(b.dataset.day); }); });
    qa("button[data-back]").forEach(function (b) { b.addEventListener("click", function () { setVideoDate(null); }); });
    qa("button[data-filter]").forEach(function (b) {
      b.addEventListener("click", function () {
        onlyMine = b.dataset.filter === "mine";
        try { localStorage.setItem("acl-only-mine", onlyMine ? "1" : "0"); } catch (e) {}
        render();
      });
    });
    qa("button[data-me]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (busy) return;
        b.disabled = true;
        var y = window.scrollY;
        act("/video/" + b.dataset.me + "/me", "POST").then(function () { window.scrollTo(0, y); }, function () {});
      });
    });
    armDelete("dv", function (id) { return act("/videos/" + id, "DELETE"); });
    qa("button[data-dday]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.armed) { act("/video/delete-date", "POST", { date: b.dataset.dday }).then(function () { setVideoDate(null); toast("Видео за день удалены."); }, function () {}); return; }
        b.dataset.armed = "1"; b.textContent = "Точно удалить все видео дня?";
        setTimeout(function () { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Удалить весь день"; } }, 4000);
      });
    });
  }

  /* ---------- Настройки (админ) ---------- */
  function viewSettings(v) {
    var st = S.settings, o = org(), mem = regular(), acc = S.accounts || [];
    var accRows = acc.map(function (a) {
      var want = a.request ? memberName(a.request) : "—";
      var sel = a.linked || a.request || "";
      return '<tr><td class="l">' + esc(a.name) + '<div class="status">' + esc(a.email) + '</div></td><td class="l">' + esc(want) + '</td><td class="l"><select data-acc="' + a.user_id + '"><option value="0">— не привязан —</option>' +
        mem.map(function (m) { return '<option value="' + m.id + '"' + (+sel === m.id ? " selected" : "") + ">" + esc(m.name) + "</option>"; }).join("") + "</select></td><td>" +
        (a.linked ? '<span class="pill ok">активен</span>' : '<button type="button" class="btn small" data-ok="' + a.user_id + '">Подтвердить</button>') + "</td></tr>";
    }).join("");
    v.innerHTML = "<div><h1>Настройки</h1></div>" +
      ((S.sessions || []).length ? "" : '<section class="panel row" style="justify-content:space-between"><div><h2>Перенос данных</h2><p class="note">Загрузить участников и тренировки из прототипа. Работает только на пустой базе.</p></div><button type="button" class="btn" id="acl-import">Импортировать</button></section>') +
      '<section class="panel" style="display:grid;gap:12px"><h2>Доступ участников</h2><p class="note">Участник регистрируется, выбирает себя в списке, и его заявка появляется здесь. После подтверждения он видит свои суммы и сам отмечает участие и оплату.</p>' +
      (acc.length ? '<div class="scroll"><table><thead><tr><th class="l">Аккаунт</th><th class="l">Выбрал себя</th><th class="l">Привязан к</th><th></th></tr></thead><tbody>' + accRows + "</tbody></table></div>" : '<div class="empty">Заявок пока нет.</div>') + "</section>" +
      '<form class="panel" id="acl-cfg" style="display:grid;gap:14px"><h2>Расчёт и участники</h2><div class="grid2">' +
      '<label for="c-rate">Аренда, ₽/час<input type="number" id="c-rate" value="' + st.rate + '" step="50"></label>' +
      '<label for="c-free">Бесплатных часов от манежа<input type="number" id="c-free" value="' + st.free_hours + '" step="0.5"></label>' +
      '<label for="c-setup">Постановка, мин<input type="number" id="c-setup" value="' + st.setup_min + '"></label>' +
      '<label for="c-clean">Уборка, мин<input type="number" id="c-clean" value="' + st.cleanup_min + '"></label>' +
      '<label for="c-org">Организатор<input id="c-org" value="' + esc(o ? o.name : "") + '"></label>' +
      '<label for="c-shares">Долей организатора<input type="number" id="c-shares" value="' + st.org_shares + '"></label>' +
      '<label for="c-disc">Скидка организатору, ₽<input type="number" id="c-disc" value="' + st.org_discount + '" step="50"></label></div>' +
      '<label for="c-mem">Участники, по одному в строке (собака владельца — отдельной строкой). Удалённые из списка скрываются, их история сохраняется.<textarea id="c-mem">' + esc(mem.map(function (m) { return m.name; }).join("\n")) + "</textarea></label>" +
      '<div class="row"><button class="btn">Сохранить</button></div></form>';

    var imp = q("#acl-import");
    if (imp) imp.addEventListener("click", function () { imp.disabled = true; act("/import", "POST").then(function () { toast("Данные перенесены."); }, function () { imp.disabled = false; }); });
    function link(uid, mid) { return act("/link", "POST", { user_id: uid, member_id: mid }); }
    qa("select[data-acc]").forEach(function (s) {
      s.addEventListener("change", function () {
        var a = acc.filter(function (x) { return String(x.user_id) === s.dataset.acc; })[0];
        if (a.linked || +s.value === 0) link(a.user_id, +s.value).then(function () { toast("Привязка изменена."); }, function () {});
      });
    });
    qa("button[data-ok]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = q('select[data-acc="' + b.dataset.ok + '"]');
        if (!s || +s.value === 0) { toast("Выберите участника в списке."); return; }
        link(+b.dataset.ok, +s.value).then(function () { toast("Участник подтверждён."); }, function () {});
      });
    });
    q("#acl-cfg").addEventListener("submit", function (e) {
      e.preventDefault();
      var names = q("#c-mem").value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      var used = {};
      var list = names.map(function (n) {
        var ex = mem.filter(function (m) { return m.name === n && !used[m.id]; })[0];
        if (ex) { used[ex.id] = true; return { id: ex.id, name: n }; }
        return { name: n };
      });
      act("/settings", "POST", {
        rate: +q("#c-rate").value, free_hours: +q("#c-free").value, setup_min: +q("#c-setup").value, cleanup_min: +q("#c-clean").value,
        org_shares: +q("#c-shares").value, org_discount: +q("#c-disc").value, organizer: q("#c-org").value.trim(), members: list
      }).then(function () { toast("Сохранено."); }, function () {});
    });
  }

  function armDelete(attr, fn) {
    qa("button[data-" + attr + "]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.armed) { fn(b.getAttribute("data-" + attr)).catch(function () {}); return; }
        b.dataset.armed = "1"; b.textContent = "Точно удалить?";
        setTimeout(function () { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Удалить"; } }, 3000);
      });
    });
  }

  api("/state").then(function (st) { S = st; render(); })
    .catch(function () { root.innerHTML = '<div class="empty">Не удалось загрузить данные. Обновите страницу.</div>'; });

  /* Свежие данные: при переключении вкладки, возврате на страницу и раз в минуту.
     Не перерисовываем, пока человек что-то вводит, чтобы не сбить ввод. */
  function refresh() {
    if (busy || !S) return;
    var a = document.activeElement;
    if (a && root.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
    // Не перерисовываем, пока смотрят видео — иначе ролик остановится
    if (Array.prototype.some.call(root.querySelectorAll("video"), function (vd) { return !vd.paused && !vd.ended; })) return;
    api("/state").then(function (st) { S = st; render(); }).catch(function () {});
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  window.addEventListener("focus", refresh);
  setInterval(function () { if (!document.hidden) refresh(); }, 60000);
})();
