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
    member:  [["schedule", "Расписание"], ["mine", "Мои тренировки"], ["news", "Новости"], ["courses", "Трассы"], ["video", "Видео"], ["notes", "Заметки"]],
    admin:   [["schedule", "Расписание"], ["sessions", "Тренировки и оплаты"], ["debts", "Расчёты"], ["news", "Новости"], ["courses", "Трассы"], ["video", "Видео"], ["notes", "Заметки"], ["settings", "Настройки"]]
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
  function apiForm(path, formData) {
    return fetch(CFG.api + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-WP-Nonce": CFG.nonce },
      body: formData
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.message) || "Ошибка сервера");
        return j;
      }, function () { throw new Error(r.status === 413 ? "Картинка слишком большая для хостинга." : "Ошибка сервера " + r.status); });
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
      b.addEventListener("click", function () { tab = b.dataset.tab; if (tab === "video") { openDate = null; openVideo = null; } if (tab === "courses") openSession = null; try { history.replaceState(null, "", "#" + tab); } catch (e) {} render(); window.scrollTo(0, 0); refresh(); });
    });
    var v = q("#acl-view");
    ({ schedule: viewSchedule, profile: viewProfile, mine: viewMine, sessions: viewSessions, debts: viewDebts, news: viewNews, courses: viewCourses, video: viewVideo, notes: viewNotes, settings: viewSettings }[tab])(v);
  }

  /* ---------- Расписание ---------- */
  function upcoming() {
    return (S.sessions || []).filter(function (s) { return s.date >= S.today; })
      .sort(function (a, b) { return (a.date + a.start).localeCompare(b.date + b.start); });
  }
  var openSession = null;
  try { var sm = /^#(?:schedule|courses)-(\d+)$/.exec(location.hash); if (sm) { openSession = +sm[1]; tab = "courses"; } } catch (e) {}
  function setSession(id) {
    openSession = id;
    tab = "courses";
    try { history.replaceState(null, "", id ? "#courses-" + id : "#courses"); } catch (e) {}
    render();
    window.scrollTo(0, 0);
  }
  function coursesFor(sid) { return (S.courses || []).filter(function (c) { return c.session_id === sid; }); }

  function viewSchedule(v) {
    var up = upcoming(), r = S.role, o = org();
    var canCourses = r === "member" || r === "admin";
    var cards = up.map(function (s) {
      var extra = "";
      if (canCourses) {
        var names = (s.org_in && o ? [o.name] : []).concat((s.att || []).map(memberName));
        extra = '<div class="who">' + (names.length ? "Записаны: " + esc(names.join(", ")) : "Пока никто не записался") + "</div>" +
          '<div class="who">С участника сейчас: <b>' + rub(s.per) + "</b></div>";
        var row = "";
        if (r === "member") {
          row += '<button type="button" class="btn small ' + (s.my ? "ghost" : "") + '" data-join="' + s.id + '">' + (s.my ? "Отменить запись" : "Записаться") + "</button>";
        }
        var cs = coursesFor(s.id);
        row += '<button type="button" class="btn small ghost" data-ses="' + s.id + '">Трассы (' + cs.length + ")</button>";
        extra += '<div class="row" style="gap:8px">' + row + "</div>";
      }
      return '<article class="slot"><div class="d">' + esc(fmtDate(s.date)) + '</div><div class="t">' + esc(s.start || "время уточняется") + " · " + esc(s.hours) + " ч</div>" + extra + "</article>";
    }).join("");
    var hint = r === "guest" ? "Чтобы записываться и видеть стоимость, войдите или зарегистрируйтесь." : r === "pending" ? "Выберите себя на вкладке «Кто вы?» — после подтверждения сможете записываться и предлагать трассы." : "Нажмите «Трассы», чтобы предложить схему на тренировку или проголосовать за чужую.";
    v.innerHTML = '<div><h1>Ближайшие тренировки</h1>' + (hint ? '<p class="lead">' + hint + "</p>" : "") + "</div>" +
      (up.length ? '<div class="cards">' + cards + "</div>" : '<div class="panel empty">Новых тренировок пока нет.</div>') +
      (S.news && S.news[0] ? '<div class="panel"><h2>Последняя новость</h2>' + postHtml(S.news[0]) + "</div>" : "");
    qa("button[data-ses]").forEach(function (b) { b.addEventListener("click", function () { setSession(+b.dataset.ses); }); });
    qa("button[data-join]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = S.sessions.filter(function (x) { return String(x.id) === b.dataset.join; })[0];
        if (s.my === "paid") { toast("Эта тренировка уже оплачена. Изменить можно во вкладке «Мои тренировки»."); return; }
        b.disabled = true;
        act("/mark", "POST", { session_id: s.id, member_id: S.me.id, mark: s.my ? "" : "Да" }).catch(function () {});
      });
    });
  }

  /* ---------- Трассы: все дни ---------- */
  function courseThumb(c, sid) {
    return '<button type="button" class="acl-cthumb" data-dayses="' + sid + '" title="Открыть схему «' + esc(c.title) + '»">' +
      (c.image ? '<img src="' + esc(c.image) + '" alt="" loading="lazy">' : '<span class="noimg">нет схемы</span>') +
      '<span class="ct">' + esc(c.title) + "</span>" +
      '<span class="cm">' + [c.length ? fmtLen(c.length) : "", c.ran ? "✓ бегали" : "", (c.results || []).length ? "результатов: " + c.results.length : ""].filter(Boolean).join(" · ") + "</span></button>";
  }
  function viewCourses(v) {
    if (openSession) {
      var ses = (S.sessions || []).filter(function (x) { return x.id === openSession; })[0];
      if (ses && S.courses) return viewSession(v, ses);
      openSession = null;
    }
    // дни: все прошедшие с трассами + все будущие тренировки; свежие сверху
    var days = (S.sessions || []).filter(function (s) { return coursesFor(s.id).length || s.date >= S.today; })
      .sort(function (a, b) { return (b.date + (b.start || "")).localeCompare(a.date + (a.start || "")); });
    var months = {};
    days.forEach(function (s) { (months[s.date.slice(0, 7)] = months[s.date.slice(0, 7)] || []).push(s); });
    var html = Object.keys(months).sort().reverse().map(function (m) {
      var p = m.split("-");
      var title = new Date(+p[0], +p[1] - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
      return '<h2 style="text-transform:capitalize">' + esc(title) + "</h2>" + months[m].map(function (s) {
        var cs = coursesFor(s.id), vids = (S.videos || []).filter(function (x) { return x.date === s.date; }).length;
        var future = s.date >= S.today;
        return '<section class="panel" style="display:grid;gap:10px">' +
          '<div class="row" style="justify-content:space-between;align-items:center;gap:8px"><h2 style="margin:0">' + esc(fmtDate(s.date)) +
          (future ? ' <span class="pill warn">' + (s.date === S.today ? "сегодня" : "впереди") + "</span>" : "") + "</h2>" +
          '<div class="row" style="gap:8px">' +
          (vids ? '<button type="button" class="btn small ghost" data-vday="' + esc(s.date) + '">Видео (' + vids + ")</button>" : "") +
          '<button type="button" class="btn small ghost" data-dayses="' + s.id + '">' + (cs.length ? "Открыть" : (future ? "+ Предложить трассу" : "+ Добавить трассу")) + "</button></div></div>" +
          (cs.length ? '<div class="acl-cthumbs">' + cs.map(function (c) { return courseThumb(c, s.id); }).join("") + "</div>" : '<div class="status">Трасс пока нет.</div>') +
          "</section>";
      }).join("");
    }).join("");
    v.innerHTML = '<div><h1>Трассы</h1><p class="lead">Схемы трасс по тренировкам, свежие сверху. Нажмите на схему — откроются схема, длина, результаты и голосование.</p></div>' +
      (html || '<div class="panel empty">Трасс пока нет.</div>');
    qa("button[data-dayses]").forEach(function (b) { b.addEventListener("click", function () { setSession(+b.dataset.dayses); window.scrollTo(0, 0); }); });
    qa("button[data-vday]").forEach(function (b) { b.addEventListener("click", function () { tab = "video"; openVideo = null; setVideoDate(b.dataset.vday); }); });
  }

  /* ---------- Тренировка: трассы и голосование ---------- */
  function viewSession(v, ses) {
    var cs = coursesFor(ses.id);
    var top = 0;
    cs.forEach(function (c) { top = Math.max(top, c.votes.length); });
    var past = ses.date < S.today;
    var items = cs.slice().sort(function (a, b) { return (past ? (b.ran - a.ran) : 0) || b.votes.length - a.votes.length || a.id - b.id; }).map(function (c) {
      var leader = top > 0 && c.votes.length === top;
      var votes = c.votes.length
        ? '<ul style="margin:6px 0 0;padding-left:18px">' + c.votes.map(function (vt) { return "<li><b>" + esc(vt.name) + ":</b> " + esc(vt.comment) + "</li>"; }).join("") + "</ul>"
        : '<div class="status">Голосов пока нет.</div>';
      var voteBox = "";
      if (!c.mine && !past) {
        voteBox = '<form class="row" data-vote="' + c.id + '" style="gap:8px;align-items:end">' +
          '<label style="flex:1;min-width:200px" for="vc-' + c.id + '">' + (c.voted ? "Ваш голос — можно изменить комментарий" : "Голосовать: почему эта трасса?") +
          '<textarea id="vc-' + c.id + '" rows="2" style="min-height:0" required placeholder="Например: хорошая связка на смену сторон">' + esc(c.my_vote) + "</textarea></label>" +
          '<button class="btn small">' + (c.voted ? "Сохранить" : "Голосовать") + "</button>" +
          (c.voted ? '<button type="button" class="btn small ghost" data-unvote="' + c.id + '">Отозвать голос</button>' : "") + "</form>";
      }
      var meta = '<div class="row" style="gap:8px;align-items:center">' +
        (c.length ? '<span class="pill ok">' + fmtLen(c.length) + "</span>" : '<span class="pill warn">длина не указана</span>') +
        (c.ran ? '<span class="pill ok">✓ Бегали</span>' : "") + "</div>";
      var editBox = c.can_edit
        ? '<form class="row" data-cedit="' + c.id + '" style="gap:8px;align-items:end">' +
          '<label for="cl-' + c.id + '">Длина, м<input id="cl-' + c.id + '" inputmode="decimal" value="' + (c.length == null ? "" : String(c.length).replace(".", ",")) + '" style="width:90px"></label>' +
          '<label style="display:flex;gap:6px;align-items:center;color:var(--fg)"><input type="checkbox" id="cr-' + c.id + '"' + (c.ran ? " checked" : "") + "> Бегали эту трассу</label>" +
          '<button class="btn small">Сохранить</button></form>'
        : "";
      var res = (c.results || []).length
        ? '<div class="scroll"><table><thead><tr><th class="l">Результаты</th><th>Штраф</th><th>Время</th><th>Скорость</th></tr></thead><tbody>' +
          c.results.map(function (r, k) { return '<tr><td class="l">' + (r.dq ? "" : k === 0 ? "🥇 " : k === 1 ? "🥈 " : k === 2 ? "🥉 " : "") + esc(r.who) + '</td><td class="num">' + (r.dq ? "снят" : r.pen) + '</td><td class="num">' + (r.time == null ? "—" : fmtTime(r.time)) + '</td><td class="num">' + (r.dq ? "—" : (fmtSpeed(r.speed) || "—")) + "</td></tr>"; }).join("") +
          "</tbody></table></div>"
        : (c.ran ? '<div class="status">Результатов пока нет — укажите трассу, время и штраф под своим видео во вкладке «Видео». Места: сначала меньше штрафа, потом быстрее.</div>' : "");
      return '<article class="panel" style="display:grid;gap:10px">' +
        '<div class="row" style="justify-content:space-between;align-items:center"><h2>' + (leader && !past ? "🏆 " : "") + esc(c.title) +
        ' <span class="pill ' + (c.votes.length ? "ok" : "warn") + '">' + c.votes.length + " " + plural(c.votes.length, "голос", "голоса", "голосов") + "</span></h2>" +
        (c.can_delete ? '<button type="button" class="btn small danger" data-dcourse="' + c.id + '">Удалить</button>' : "") + "</div>" +
        '<div class="status">Предложил(а): ' + esc(c.author) + (c.mine ? " (вы)" : "") + "</div>" +
        (c.image ? '<a href="' + esc(c.image) + '" target="_blank" rel="noopener"><img src="' + esc(c.image) + '" alt="Схема трассы «' + esc(c.title) + '»" style="width:100%;max-height:70vh;object-fit:contain;border-radius:8px;background:var(--bg);border:1px solid var(--line)"></a>' : "") +
        (c.note ? '<p style="margin:0;white-space:pre-wrap">' + esc(c.note) + "</p>" : "") +
        meta + editBox + res + votes + voteBox + "</article>";
    }).join("");
    var form =
      '<details class="panel"' + (cs.length ? "" : " open") + '><summary style="cursor:pointer;font-weight:600">' + (past ? "+ Добавить трассу, которую бегали" : "+ Предложить трассу") + "</summary>" +
      '<form id="acl-cf" style="display:grid;gap:10px;margin-top:12px">' +
      '<label for="cf-title">Название<input id="cf-title" required maxlength="200" placeholder="Например: Джампинг на смены сторон"></label>' +
      '<label for="cf-len">Длина трассы, м<input id="cf-len" inputmode="decimal" placeholder="Например: 160" style="max-width:160px"></label>' +
      '<label for="cf-img">Схема трассы (фото или скриншот: JPG, PNG, WebP)' + (past ? " — необязательно" : "") + '<input id="cf-img" type="file" accept="image/*"' + (past ? "" : " required") + "></label>" +
      '<img id="cf-prev" alt="" hidden style="max-width:100%;max-height:300px;object-fit:contain;border-radius:8px">' +
      '<label for="cf-note">Комментарий (необязательно)<textarea id="cf-note" rows="3" style="min-height:0" placeholder="Что отрабатываем, на что обратить внимание"></textarea></label>' +
      '<div class="row"><button class="btn" id="cf-send">Предложить</button><span class="status" id="cf-status"></span></div></form></details>';
    var dayVids = (S.videos || []).filter(function (x) { return x.date === ses.date; }).length;
    v.innerHTML = '<div class="row" style="gap:8px"><button type="button" class="btn small ghost" data-back="1">← Все трассы</button>' +
      (dayVids ? '<button type="button" class="btn small ghost" data-vday="' + esc(ses.date) + '">Видео этого дня (' + dayVids + ")</button>" : "") + "</div>" +
      "<div><h1>Трассы · " + esc(fmtDate(ses.date)) + "</h1>" +
      '<p class="lead">' + esc(ses.start || "") + " · " + esc(ses.hours) + " ч. " +
      (past ? "Тренировка прошла: отметьте «Бегали» у схем, которые бегали, укажите длину — и под видео можно будет ввести время и получить скорость." : "Предложите свою схему или проголосуйте за чужую с комментарием. За свою трассу голосовать нельзя.") + "</p></div>" +
      form + (items || '<div class="panel empty">Трасс пока не предложили.</div>');

    q("[data-back]").addEventListener("click", function () { setSession(null); });
    qa("button[data-vday]").forEach(function (b) { b.addEventListener("click", function () { tab = "video"; openVideo = null; setVideoDate(b.dataset.vday); }); });
    var f = q("#acl-cf");
    if (f) {
      q("#cf-img").addEventListener("change", function () {
        var file = this.files && this.files[0], pv = q("#cf-prev");
        if (file) { try { pv.src = URL.createObjectURL(file); pv.hidden = false; } catch (e) {} }
      });
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var file = q("#cf-img").files[0];
        if (!file && !past) { toast("Прикрепите картинку схемы."); return; }
        if (file && file.size > 15 * 1048576) { toast("Картинка больше 15 МБ — сожмите или сделайте скриншот."); return; }
        var fd = new FormData();
        fd.append("session_id", ses.id);
        fd.append("title", q("#cf-title").value.trim());
        fd.append("note", q("#cf-note").value.trim());
        fd.append("length", q("#cf-len").value.trim());
        if (file) fd.append("image", file, file.name || "trassa.jpg");
        q("#cf-send").disabled = true;
        q("#cf-status").textContent = "Загружаю…";
        apiForm("/courses", fd).then(function (st) { S = st; render(); toast(past ? "Трасса добавлена." : "Трасса предложена."); }, function (err) {
          q("#cf-send").disabled = false;
          q("#cf-status").textContent = "";
          toast(err.message);
        });
      });
    }
    qa("form[data-vote]").forEach(function (fm) {
      fm.addEventListener("submit", function (e) {
        e.preventDefault();
        var id = fm.dataset.vote, txt = fm.querySelector("textarea").value.trim();
        if (!txt) { toast("Напишите комментарий к голосу."); return; }
        act("/courses/" + id + "/vote", "POST", { comment: txt }).then(function () { toast("Голос учтён."); }, function () {});
      });
    });
    qa("button[data-unvote]").forEach(function (b) { b.addEventListener("click", function () { act("/courses/" + b.dataset.unvote + "/vote", "DELETE").then(function () { toast("Голос отозван."); }, function () {}); }); });
    armDelete("dcourse", function (id) { return act("/courses/" + id, "DELETE"); });
    qa("form[data-cedit]").forEach(function (fm) {
      fm.addEventListener("submit", function (e) {
        e.preventDefault();
        var id = fm.dataset.cedit;
        act("/courses/" + id + "/edit", "POST", { length: q("#cl-" + id).value, ran: q("#cr-" + id).checked }).then(function () { toast("Сохранено."); }, function () {});
      });
    });
  }

  function fmtTime(t) {
    if (t == null) return "";
    if (t >= 60) { var m = Math.floor(t / 60), sec = t - m * 60; return m + ":" + (sec < 10 ? "0" : "") + sec.toFixed(2).replace(".", ","); }
    return t.toFixed(2).replace(".", ",") + " с";
  }
  function fmtSpeed(v) { return v == null ? "" : v.toFixed(2).replace(".", ",") + " м/с"; }
  function fmtLen(l) { return l == null ? "" : String(l).replace(".", ",") + " м"; }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
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
  /* Письма о новых тренировках и трассах */
  function notifyBox() {
    return '<label style="display:flex;gap:8px;align-items:center;color:var(--fg)"><input type="checkbox" id="acl-notify-me"' + (S.notify ? " checked" : "") + "> Присылать мне на почту письма о новых тренировках и трассах</label>";
  }
  function bindNotify() {
    var cb = q("#acl-notify-me");
    if (!cb) return;
    cb.addEventListener("change", function () {
      cb.disabled = true;
      api("/notify", "POST", { on: cb.checked }).then(function (st) { S = st; cb.disabled = false; toast(cb.checked ? "Письма включены." : "Письма отключены."); },
        function (e) { cb.disabled = false; cb.checked = !cb.checked; toast(e.message); });
    });
  }

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
      (list.length ? '<div class="scroll"><table><thead><tr><th class="l">Дата</th><th>Начало</th><th>Часы</th><th>Долей</th><th>Моя сумма</th><th>Отметка</th></tr></thead><tbody>' + rows + "</tbody></table></div>" : '<div class="panel empty">Тренировок пока нет.</div>') +
      '<section class="panel">' + notifyBox() + "</section>";
    bindNotify();
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
  var vFilter = "all"; // all | mine | fav
  try { vFilter = localStorage.getItem("acl-vfilter") || (localStorage.getItem("acl-only-mine") === "1" ? "mine" : "all"); } catch (e) {}
  function passes(x) { return vFilter === "mine" ? x.mine : vFilter === "fav" ? x.fav : true; }
  function filterLabels() {
    var all = S.videos || [];
    return {
      all: "Все видео (" + all.length + ")",
      mine: "Только мои (" + all.filter(function (x) { return x.mine; }).length + ")",
      fav: "⭐ Избранное (" + all.filter(function (x) { return x.fav; }).length + ")"
    };
  }

  var openDate = null; // выбранный день на вкладке «Видео»
  try { var hm = /^#video-(\d{4}-\d{2}-\d{2})$/.exec(location.hash); if (hm) { openDate = hm[1]; tab = "video"; } } catch (e) {}

  function setVideoDate(d) {
    openDate = d;
    try { history.replaceState(null, "", d ? "#video-" + d : "#video"); } catch (e) {}
    openVideo = null;
    render();
    window.scrollTo(0, 0);
  }

  var bigView = true;
  try { bigView = localStorage.getItem("acl-video-view") !== "small"; } catch (e) {}

  function meButton(x) {
    return '<button type="button" class="btn small ' + (x.mine ? "" : "ghost") + '" data-me="' + x.id + '" aria-pressed="' + (x.mine ? "true" : "false") + '">' + (x.mine ? "✓ Это я" : "Это я") + "</button>";
  }
  function itemActions(x, a, logged) {
    var days = +(S.video_days || 30);
    var mark = x.can_mark
      ? (x.marked
          ? '<button type="button" class="btn small" data-mark="' + x.id + '">Отменить удаление</button>'
          : '<button type="button" class="btn small danger" data-mark="' + x.id + '">Удалить</button>')
      : "";
    var fav = logged && x.mine
      ? '<button type="button" class="btn small ' + (x.fav ? "" : "ghost") + '" data-fav="' + x.id + '" aria-pressed="' + (x.fav ? "true" : "false") + '" title="Избранное">' + (x.fav ? "⭐ В избранном" : "☆ В избранное") + "</button>"
      : "";
    return (logged ? meButton(x) : "") + fav + mark +
      (a ? '<button type="button" class="btn small danger" data-dv="' + x.id + '">Удалить сейчас</button>' : "");
  }
  function itemTagged(x) {
    var parts = [];
    if ((x.tagged || []).length) parts.push("На видео: " + x.tagged.join(", "));
    if (x.marked) parts.push("🗑 Удалится " + (x.days_left ? "через " + x.days_left + " " + plural(x.days_left, "день", "дня", "дней") : "сегодня ночью") + (x.marked_by ? " (пометил: " + x.marked_by + ")" : ""));
    return parts.join(" · ");
  }

  function videoItem(x, a, logged) {
    var local = +x.local === 1;
    var media = local
      ? '<video controls preload="metadata" playsinline src="' + esc(x.url) + '" class="acl-video"></video>'
      : '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">Открыть видео</a>';
    var time = (/(\d{1,2}:\d{2})\s*$/.exec(x.title) || [])[1];
    var head = '<h3 data-vhead="' + x.id + '"' + (bigView ? "" : ' style="font-size:14px"') + ">" + headInner(x, bigView ? x.title : (time || x.title)) + "</h3>";
    return '<div class="post acl-vitem" data-vid="' + x.id + '">' + head + media + runBlock(x) + '<div data-notes="' + x.id + '">' + notesInner(x) + "</div>" +
      '<div class="status" data-tagged="' + x.id + '">' + esc(itemTagged(x)) + "</div>" +
      '<div class="row" style="gap:8px" data-acts="' + x.id + '">' + itemActions(x, a, logged) + "</div></div>";
  }

  /* Своё название видео */
  function headInner(x, base) {
    var t = (/(\d{1,2}:\d{2})\s*$/.exec(x.title) || [])[1] || base;
    return (x.label ? "<b>" + esc(x.label) + '</b> <span class="status">' + esc(t) + "</span>" : esc(base)) +
      (x.size ? ' <span class="status">' + mb(+x.size) + "</span>" : "") +
      (x.can_run ? ' <button type="button" class="btn small ghost" data-rn="' + x.id + '" title="Дать название видео" style="padding:2px 8px">✏️</button>' : "");
  }
  function bindRename(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll("button[data-rn]"), function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.rn, h = b.closest("[data-vhead]");
        if (h.nextElementSibling && h.nextElementSibling.hasAttribute("data-rnf")) { h.nextElementSibling.querySelector("input").focus(); return; }
        var x = (S.videos || []).filter(function (v) { return String(v.id) === String(id); })[0] || {};
        var fm = document.createElement("form");
        fm.setAttribute("data-rnf", "");
        fm.className = "row";
        fm.style.cssText = "gap:6px;margin:4px 0;align-items:center";
        fm.innerHTML = '<input maxlength="200" placeholder="Например: Слалом, Дейзи" style="flex:1;min-width:150px" value="' + esc(x.label || "") + '">' +
          '<button class="btn small">Сохранить</button><button type="button" class="btn small ghost" data-rnc>Отмена</button>';
        h.insertAdjacentElement("afterend", fm);
        var inp = fm.querySelector("input"); inp.focus(); inp.select();
        fm.querySelector("[data-rnc]").addEventListener("click", function () { fm.remove(); });
        fm.addEventListener("submit", function (e) {
          e.preventDefault();
          api("/video/" + id + "/name", "POST", { name: inp.value }).then(function (st) {
            S = st;
            var nx = (S.videos || []).filter(function (v) { return String(v.id) === String(id); })[0];
            if (nx) {
              var big = h.getAttribute("style") == null;
              var tm = (/(\d{1,2}:\d{2})\s*$/.exec(nx.title) || [])[1];
              h.innerHTML = headInner(nx, big ? nx.title : (tm || nx.title));
              bindRename(h);
              var h1 = root.querySelector("[data-onetitle]"); if (h1) h1.textContent = nx.label || nx.title;
            }
            fm.remove();
            toast(nx && nx.label ? "Название сохранено." : "Название убрано.");
          }, function (err) { toast(err.message); });
        });
      });
    });
  }

  function courseById(id) { return (S.course_titles || []).filter(function (c) { return c.id === id; })[0]; }
  function runInfo(x) {
    var c = x.course_id ? courseById(x.course_id) : null;
    if (!c) return "";
    var sp = c.length && x.run_time ? c.length / x.run_time : null;
    return "🏁 " + esc(c.title) + (c.length ? " · " + fmtLen(c.length) : "") +
      (x.run_dq ? " · <b>снят</b>" : x.run_time || x.run_pen ? " · штраф <b>" + x.run_pen + "</b>" : "") +
      (x.run_time ? " · <b>" + fmtTime(x.run_time) + "</b>" : "") + (sp && !x.run_dq ? " · <b>" + fmtSpeed(Math.round(sp * 100) / 100) + "</b>" : "");
  }
  function runBlock(x) {
    var info = runInfo(x);
    var html = '<div class="status" data-run="' + x.id + '"' + (info ? "" : " hidden") + ">" + info + "</div>";
    if (!x.can_run) return html;
    var opts = (S.course_titles || []).filter(function (c) { return c.date === x.date; })
      .sort(function (a, b) { return b.ran - a.ran || a.id - b.id; });
    if (!opts.length) return html + '<div class="status">Трасс этого дня нет — добавьте во вкладке «Расписание → Трассы».</div>';
    return html + '<details style="margin-top:4px"><summary style="cursor:pointer;font-size:13px;color:var(--accent)">' + (x.course_id ? "Изменить трассу, время, штраф · ⏱ секундомер" : "Указать трассу, время, штраф · ⏱ секундомер") + "</summary>" + (+x.local === 1 ? timerBar(x.id) : "") +
      '<form class="row" data-runf="' + x.id + '" style="gap:8px;align-items:end;margin-top:6px">' +
      '<label for="rc-' + x.id + '" style="flex:1;min-width:140px">Трасса<select id="rc-' + x.id + '"><option value="0">— не выбрана —</option>' +
      opts.map(function (c) { return '<option value="' + c.id + '"' + (x.course_id === c.id ? " selected" : "") + ">" + esc(c.title) + (c.length ? " (" + fmtLen(c.length) + ")" : "") + (c.ran ? "" : " — не отмечена «Бегали»") + "</option>"; }).join("") +
      "</select></label>" +
      '<label for="rt-' + x.id + '">Время, с<input id="rt-' + x.id + '" data-k="time" inputmode="decimal" placeholder="38,45" style="width:90px" value="' + (x.run_time == null ? "" : String(x.run_time).replace(".", ",")) + '"></label>' +
      '<label for="rp-' + x.id + '">Штраф, баллы<input id="rp-' + x.id + '" data-k="pen" inputmode="numeric" placeholder="0" style="width:80px" value="' + (x.run_pen ? x.run_pen : "") + '"></label>' +
      '<label style="display:flex;gap:6px;align-items:center;color:var(--fg)"><input type="checkbox" data-k="dq"' + (x.run_dq ? " checked" : "") + "> Снят</label>" +
      '<button class="btn small">Сохранить</button></form></details>';
  }

  /* ---------- Вкладка «Заметки» ---------- */
  var pendingSeek = null;
  var notesFilter = "own"; // own | onmine | all
  try { notesFilter = localStorage.getItem("acl-notes-filter") || "own"; } catch (e) {}
  var notesGroup = "day"; // day | video
  var notesQuery = "";
  try { notesGroup = localStorage.getItem("acl-notes-group") || "day"; } catch (e) {}
  function hl(text, words) {
    var h = esc(text);
    words.forEach(function (w) {
      var ew = esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      h = h.replace(new RegExp("(" + ew + ")", "gi"), "<mark>$1</mark>");
    });
    return h;
  }
  function viewNotes(v) {
    var a = S.role === "admin";
    var rows = [];
    (S.videos || []).forEach(function (x) {
      (x.notes || []).forEach(function (n) { rows.push({ n: n, x: x }); });
    });
    var F = {
      own: function (r) { return r.n.own; },
      onmine: function (r) { return r.x.mine; },
      all: function () { return true; }
    };
    var keys = a ? ["own", "onmine", "all"] : ["own", "onmine"];
    if (keys.indexOf(notesFilter) < 0) notesFilter = "own";
    var label = { own: "Мои заметки", onmine: "К моим видео", all: "Все заметки" };
    function vtime(x) { var t = (/(\d{1,2}:\d{2})\s*$/.exec(x.title) || [])[1] || x.title; return x.label ? x.label + " · " + t : t; }
    function ctitle(x) { var c = x.course_id && courseById(x.course_id); return c ? c.title : ""; }

    v.innerHTML = '<div><h1>Заметки</h1><p class="lead">На что обратить внимание в видео. Нажмите на заметку — откроется видео на этом моменте. Новую заметку добавляют под роликом кнопкой «📝 На что обратить внимание».</p></div>' +
      '<div class="row" style="gap:8px" role="group" aria-label="Какие заметки показать">' + keys.map(function (k) {
        return '<button type="button" class="btn small ' + (notesFilter === k ? "" : "ghost") + '" data-nf="' + k + '">' + label[k] + " (" + rows.filter(F[k]).length + ")</button>";
      }).join("") + "</div>" +
      '<div class="row" style="gap:8px;align-items:center">' +
      '<input type="search" id="acl-nq" placeholder="🔍 Поиск: слово, имя, трасса, название видео…" value="' + esc(notesQuery) + '" style="flex:1;min-width:180px" aria-label="Поиск по заметкам">' +
      '<div class="row" style="gap:6px" role="group" aria-label="Группировка">' +
      '<button type="button" class="btn small ' + (notesGroup === "day" ? "" : "ghost") + '" data-ng="day">По дням</button>' +
      '<button type="button" class="btn small ' + (notesGroup === "video" ? "" : "ghost") + '" data-ng="video">По видео</button></div></div>' +
      '<div id="acl-nlist" style="display:grid;gap:12px"></div>';

    function noteRow(r, words, showVideo) {
      var who = esc(r.n.who), ct = ctitle(r.x);
      return '<div class="acl-note" style="display:flex;flex-wrap:wrap;gap:4px 8px;align-items:flex-start;padding:6px 8px;border-left:3px solid var(--accent);background:var(--soft,rgba(0,0,0,.03));border-radius:6px">' +
        '<button type="button" class="btn small ghost" data-go="' + r.x.id + '" data-gt="' + r.n.t + '" style="white-space:normal;text-align:left;font-family:ui-monospace,monospace">▶ ' + (showVideo ? hl(vtime(r.x), words) + " · " : "") + fmtMs(r.n.t) + " · кадр " + r.n.frame + "</button>" +
        '<div style="flex:1 1 180px;min-width:0"><div style="white-space:pre-wrap">' + hl(r.n.text, words) + '</div><div class="status">' + hl(r.n.who, words) +
        (showVideo && ct ? " · 🏁 " + hl(ct, words) : "") + "</div></div>" +
        (r.n.can_delete ? '<button type="button" class="btn small ghost" data-dnote2="' + r.n.id + '" title="Удалить заметку">✕</button>' : "") + "</div>";
    }

    function drawList() {
      var words = notesQuery.toLowerCase().split(/\s+/).filter(Boolean);
      var list = rows.filter(F[notesFilter]).filter(function (r) {
        if (!words.length) return true;
        var hay = (r.n.text + " " + r.n.who + " " + ctitle(r.x) + " " + r.x.title + " " + (r.x.label || "") + " " + fmtDate(r.x.date)).toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      }).sort(function (p, r) {
        return r.x.date.localeCompare(p.x.date) || (+p.x.id - +r.x.id) || p.n.t - r.n.t;
      });
      var box = q("#acl-nlist");
      if (!list.length) {
        box.innerHTML = '<div class="panel empty">' + (words.length ? "Ничего не найдено по запросу «" + esc(notesQuery) + "»." :
          notesFilter === "own" ? "Вы ещё не писали заметок. Откройте видео во вкладке «Видео» и нажмите «📝 На что обратить внимание»." :
          notesFilter === "onmine" ? "К вашим видео (где стоит «Это я») заметок пока нет." : "Заметок пока нет.") + "</div>";
        return;
      }
      var html = words.length ? '<p class="status" style="margin:0">Найдено: ' + list.length + "</p>" : "";
      if (notesGroup === "video") {
        var order = [], byV = {};
        list.forEach(function (r) { if (!byV[r.x.id]) { byV[r.x.id] = []; order.push(r.x); } byV[r.x.id].push(r); });
        html += order.map(function (x) {
          var ct = ctitle(x);
          return '<section class="panel" style="display:grid;gap:6px">' +
            '<div class="row" style="justify-content:space-between;align-items:center;gap:8px"><h2 style="margin:0">' + esc(fmtDate(x.date)) + " · " + hl(vtime(x), words) + "</h2>" +
            '<button type="button" class="btn small" data-open="' + x.id + '">▶ Открыть видео</button></div>' +
            (ct || (x.tagged || []).length ? '<div class="status">' + (ct ? "🏁 " + hl(ct, words) : "") + (ct && (x.tagged || []).length ? " · " : "") + ((x.tagged || []).length ? "На видео: " + esc(x.tagged.join(", ")) : "") + "</div>" : "") +
            byV[x.id].map(function (r) { return noteRow(r, words, false); }).join("") + "</section>";
        }).join("");
      } else {
        var byDate = {};
        list.forEach(function (r) { (byDate[r.x.date] = byDate[r.x.date] || []).push(r); });
        html += Object.keys(byDate).sort().reverse().map(function (d) {
          return '<section class="panel" style="display:grid;gap:6px"><h2>' + esc(fmtDate(d)) + "</h2>" +
            byDate[d].map(function (r) { return noteRow(r, words, true); }).join("") + "</section>";
        }).join("");
      }
      box.innerHTML = html;
      Array.prototype.forEach.call(box.querySelectorAll("button[data-go]"), function (b) {
        b.addEventListener("click", function () { showVideo(b.dataset.go, +b.dataset.gt, "notes"); });
      });
      Array.prototype.forEach.call(box.querySelectorAll("button[data-open]"), function (b) {
        b.addEventListener("click", function () { showVideo(b.dataset.open, null, "notes"); });
      });
      Array.prototype.forEach.call(box.querySelectorAll("button[data-dnote2]"), function (b) {
        b.addEventListener("click", function () {
          if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Удалить?"; setTimeout(function () { if (b.isConnected) { delete b.dataset.armed; b.textContent = "✕"; } }, 3000); return; }
          act("/video/note/" + b.dataset.dnote2, "DELETE").then(function () { toast("Заметка удалена."); }, function () {});
        });
      });
    }
    drawList();

    qa("button[data-nf]").forEach(function (b) {
      b.addEventListener("click", function () { notesFilter = b.dataset.nf; try { localStorage.setItem("acl-notes-filter", notesFilter); } catch (e) {} render(); });
    });
    qa("button[data-ng]").forEach(function (b) {
      b.addEventListener("click", function () { notesGroup = b.dataset.ng; try { localStorage.setItem("acl-notes-group", notesGroup); } catch (e) {} render(); });
    });
    var inp = q("#acl-nq");
    inp.addEventListener("input", function () { notesQuery = inp.value; drawList(); });
  }

  /* Заметки «На что обратить внимание» с моментом видео */
  function notesInner(x) {
    var list = (x.notes || []).map(function (n) {
      return '<div class="acl-note" style="display:flex;flex-wrap:wrap;gap:4px 8px;align-items:flex-start;padding:6px 8px;border-left:3px solid var(--accent);background:var(--soft,rgba(0,0,0,.03));border-radius:6px;margin-top:4px">' +
        '<button type="button" class="btn small ghost" data-seek="' + n.t + '" title="Перейти к этому моменту" style="white-space:nowrap;font-family:ui-monospace,monospace">⏱ ' + fmtMs(n.t) + " · кадр " + n.frame + "</button>" +
        '<div style="flex:1 1 180px;min-width:0"><div style="white-space:pre-wrap">' + esc(n.text) + '</div><div class="status">' + esc(n.who) + "</div></div>" +
        (n.can_delete ? '<button type="button" class="btn small ghost" data-dnote="' + n.id + '" title="Удалить заметку">✕</button>' : "") + "</div>";
    }).join("");
    var form = x.can_run && +x.local === 1
      ? '<details data-notef="' + x.id + '" style="margin-top:6px"><summary style="cursor:pointer;font-size:13px;color:var(--accent)">📝 На что обратить внимание</summary>' +
        '<form style="display:grid;gap:8px;margin-top:6px">' +
        '<div class="row" style="gap:6px;align-items:center"><span data-nt style="font:600 16px/1 ui-monospace,monospace">0:00,000 · кадр 0</span>' +
        '<button type="button" class="btn small ghost" data-nstep="-1">◀ кадр</button><button type="button" class="btn small ghost" data-nstep="1">кадр ▶</button>' +
        '<button type="button" class="btn small ghost" data-nfix>Зафиксировать текущий момент</button></div>' +
        '<label>Что заметили<textarea rows="2" maxlength="2000" placeholder="Например: поздняя команда на смену сторон, собака сбила планку"></textarea></label>' +
        '<div class="row"><button class="btn small">Сохранить заметку</button></div></form></details>'
      : "";
    return list + form;
  }
  function bindNotes(box) {
    var id = box.dataset.notes, item = box.closest(".acl-vitem"), vd = item && item.querySelector("video");
    Array.prototype.forEach.call(box.querySelectorAll("[data-seek]"), function (b) {
      b.addEventListener("click", function () {
        if (!vd) return;
        frameMode(vd, true); vd.currentTime = +b.dataset.seek;
        vd.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-dnote]"), function (b) {
      b.addEventListener("click", function () {
        if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Удалить?"; setTimeout(function () { if (b.isConnected) { delete b.dataset.armed; b.textContent = "✕"; } }, 3000); return; }
        api("/video/note/" + b.dataset.dnote, "DELETE").then(function (st) { S = st; redrawNotes(id); toast("Заметка удалена."); }, function (e) { toast(e.message); });
      });
    });
    var det = box.querySelector("[data-notef]");
    if (!det || !vd) return;
    var fm = det.querySelector("form"), lab = det.querySelector("[data-nt]"), t = 0;
    function fix() { t = Math.round(vd.currentTime * 1000) / 1000; lab.textContent = fmtMs(t) + " · кадр " + Math.round(t * FPS); }
    det.addEventListener("toggle", function () { if (det.open) { vd.pause(); fix(); } });
    det.querySelector("[data-nfix]").addEventListener("click", function () { vd.pause(); fix(); });
    Array.prototype.forEach.call(det.querySelectorAll("[data-nstep]"), function (b) {
      b.addEventListener("click", function () { frameMode(vd, true); vd.currentTime = Math.max(0, vd.currentTime + (+b.dataset.nstep) / FPS); });
    });
    vd.addEventListener("seeked", function () { if (det.open) fix(); });
    fm.addEventListener("submit", function (e) {
      e.preventDefault();
      var txt = fm.querySelector("textarea").value.trim(), btn = fm.querySelector("button:not([type=button])");
      if (!txt) { toast("Напишите, на что обратить внимание."); return; }
      btn.disabled = true;
      api("/video/" + id + "/note", "POST", { t: t, text: txt }).then(function (st) { S = st; redrawNotes(id); toast("Заметка сохранена: " + fmtMs(t)); }, function (err) { btn.disabled = false; toast(err.message); });
    });
  }
  function redrawNotes(id) {
    var x = (S.videos || []).filter(function (v) { return String(v.id) === String(id); })[0];
    var box = root.querySelector('[data-notes="' + id + '"]');
    if (x && box) { box.innerHTML = notesInner(x); bindNotes(box); }
  }

  /* Секундомер по кадрам: время стоп-кадра с миллисекундами, отметки «Старт»/«Финиш» */
  var FPS = 30; // приложение сжимает видео в 30 кадров/с
  var marks = {}; // id видео → {s, f}
  function fmtMs(t) {
    if (t == null || isNaN(t)) return "—";
    var m = Math.floor(t / 60), sec = t - m * 60;
    return m + ":" + (sec < 10 ? "0" : "") + sec.toFixed(3).replace(".", ",");
  }
  function timerBar(id) {
    var mk = marks[id] || {};
    return '<div class="acl-timer" data-timer="' + id + '" style="display:grid;gap:6px;margin-top:8px;padding:8px;border:1px dashed var(--line);border-radius:10px">' +
      '<div class="row" style="gap:8px;align-items:center;justify-content:space-between"><span style="font:600 20px/1 ui-monospace,monospace" data-now>0:00,000</span>' +
      '<span class="status">кадр ≈ ' + Math.round(1000 / FPS) + " мс</span></div>" +
      '<div class="row" style="gap:6px">' +
      '<button type="button" class="btn small ghost" data-step="-1">◀ кадр</button>' +
      '<button type="button" class="btn small ghost" data-step="1">кадр ▶</button>' +
      '<button type="button" class="btn small ghost" data-slow>Замедлить 0,25×</button></div>' +
      '<div class="row" style="gap:6px;align-items:center">' +
      '<button type="button" class="btn small" data-mk="s">Старт</button><span class="status" data-ms>' + fmtMs(mk.s) + "</span>" +
      '<button type="button" class="btn small" data-mk="f">Финиш</button><span class="status" data-mf>' + fmtMs(mk.f) + "</span></div>" +
      '<div class="status" data-res>' + (mk.s != null && mk.f != null ? "Время забега: <b>" + (mk.f - mk.s).toFixed(2).replace(".", ",") + " с</b>" : "Поставьте видео на паузу в момент старта и нажмите «Старт», затем то же на финише. Кнопки «кадр» двигают видео на 1/30 секунды.") + "</div></div>";
  }
  /* Покадровый режим: убираем стандартные кнопки плеера (белый кружок на телефоне), показываем свою панель */
  function frameMode(vd, on) {
    if (!vd) return;
    var bar = vd.nextElementSibling && vd.nextElementSibling.hasAttribute("data-fbar") ? vd.nextElementSibling : null;
    if (!on) {
      vd.setAttribute("controls", "");
      if (bar) bar.remove();
      return;
    }
    vd.pause();
    if (bar) return;
    vd.removeAttribute("controls");
    bar = document.createElement("div");
    bar.setAttribute("data-fbar", "");
    bar.className = "row";
    bar.style.cssText = "gap:6px;margin:6px 0;align-items:center;flex-wrap:wrap";
    bar.innerHTML =
      '<button type="button" class="btn small" data-fb="play" style="min-width:44px">▶</button>' +
      '<button type="button" class="btn small ghost" data-fb="-1">−1 с</button>' +
      '<button type="button" class="btn small ghost" data-fb="-f">◀ кадр</button>' +
      '<button type="button" class="btn small ghost" data-fb="+f">кадр ▶</button>' +
      '<button type="button" class="btn small ghost" data-fb="+1">+1 с</button>' +
      '<button type="button" class="btn small ghost" data-fb="off">Обычный плеер</button>' +
      '<span data-ft style="font:600 14px/1 ui-monospace,monospace;margin-left:auto"></span>';
    vd.insertAdjacentElement("afterend", bar);
    var pb = bar.querySelector('[data-fb="play"]');
    var ft = bar.querySelector("[data-ft]");
    function sync() { pb.textContent = vd.paused ? "▶" : "⏸"; ft.textContent = fmtMs(vd.currentTime) + " · кадр " + Math.round(vd.currentTime * FPS); }
    ["play", "pause", "seeked", "timeupdate"].forEach(function (ev) { vd.addEventListener(ev, function () { if (bar.isConnected) sync(); }); });
    sync();
    function step(d) { vd.pause(); vd.currentTime = Math.max(0, Math.min(vd.duration || 1e9, vd.currentTime + d)); }
    bar.addEventListener("click", function (e) {
      var b = e.target.closest("[data-fb]"); if (!b) return;
      var k = b.dataset.fb;
      if (k === "play") { if (vd.paused) vd.play(); else vd.pause(); }
      else if (k === "off") frameMode(vd, false);
      else if (k === "-1") step(-1); else if (k === "+1") step(1);
      else if (k === "-f") step(-1 / FPS); else if (k === "+f") step(1 / FPS);
    });
    if (!vd.dataset.tapbound) {
      vd.dataset.tapbound = "1";
      vd.addEventListener("click", function () { if (!vd.hasAttribute("controls")) { if (vd.paused) vd.play(); else vd.pause(); } });
    }
  }

  function bindTimer(box) {
    var id = box.dataset.timer, item = box.closest(".acl-vitem"), vd = item && item.querySelector("video");
    if (!vd) return;
    var now = box.querySelector("[data-now]"), raf = 0;
    function show() { now.textContent = fmtMs(vd.currentTime); }
    function loop() { show(); if (!vd.paused && !vd.ended) raf = requestAnimationFrame(loop); }
    vd.addEventListener("play", function () { cancelAnimationFrame(raf); loop(); });
    vd.addEventListener("seeked", show);
    vd.addEventListener("pause", show);
    vd.addEventListener("loadedmetadata", show);
    show();
    Array.prototype.forEach.call(box.querySelectorAll("[data-step]"), function (b) {
      b.addEventListener("click", function () {
        frameMode(vd, true);
        vd.currentTime = Math.max(0, Math.min(vd.duration || 1e9, vd.currentTime + (+b.dataset.step) / FPS));
      });
    });
    var slow = box.querySelector("[data-slow]");
    slow.addEventListener("click", function () {
      vd.playbackRate = vd.playbackRate === 1 ? 0.25 : 1;
      slow.textContent = vd.playbackRate === 1 ? "Замедлить 0,25×" : "Обычная скорость";
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-mk]"), function (b) {
      b.addEventListener("click", function () {
        var mk = marks[id] = marks[id] || {};
        mk[b.dataset.mk] = Math.round(vd.currentTime * 1000) / 1000;
        box.querySelector("[data-ms]").textContent = fmtMs(mk.s);
        box.querySelector("[data-mf]").textContent = fmtMs(mk.f);
        var res = box.querySelector("[data-res]");
        if (mk.s != null && mk.f != null) {
          var d = mk.f - mk.s;
          if (d <= 0) { res.textContent = "Финиш должен быть позже старта."; return; }
          var inp = item.querySelector('form[data-runf] [data-k="time"]');
          if (inp) inp.value = d.toFixed(2).replace(".", ",");
          res.innerHTML = "Время забега: <b>" + d.toFixed(2).replace(".", ",") + " с</b> — подставлено в поле «Время». Выберите трассу и нажмите «Сохранить».";
        }
      });
    });
  }

  /* «Это я» и «Удалить» без перерисовки страницы: меняем только кнопки, подпись и счётчики */
  function toggleMe(id, btn, path, okMsg) {
    if (btn.dataset.wait) return;
    btn.dataset.wait = "1";
    btn.disabled = true;
    api("/video/" + id + (path || "/me"), "POST").then(function (st) {
      S = st;
      var x = (S.videos || []).filter(function (v) { return String(v.id) === String(id); })[0];
      if (!x) { render(); return; }
      if (!passes(x)) { render(); return; } // в режиме «Только мои»/«Избранное» ролик должен исчезнуть
      var acts = root.querySelector('[data-acts="' + id + '"]');
      if (acts) { acts.innerHTML = itemActions(x, S.role === "admin", !!S.user); bindVideoButtons(acts); }
      var tg = root.querySelector('[data-tagged="' + id + '"]');
      if (tg) tg.textContent = itemTagged(x);
      redrawNotes(id);
      var lb = filterLabels();
      Array.prototype.forEach.call(root.querySelectorAll("button[data-filter]"), function (b) { b.textContent = lb[b.dataset.filter]; });
      toast(okMsg ? okMsg(x) : (x.mine ? "Отмечено: это вы." : "Отметка снята."));
    }, function (e) {
      btn.disabled = false;
      delete btn.dataset.wait;
      toast(e.message || "Не сохранилось. Попробуйте ещё раз.");
    });
  }

  function bindVideoButtons(scope) {
    bindRename(scope);
    Array.prototype.forEach.call(scope.querySelectorAll("[data-timer]"), bindTimer);
    Array.prototype.forEach.call(scope.querySelectorAll("[data-notes]"), bindNotes);
    Array.prototype.forEach.call(scope.querySelectorAll("form[data-runf]"), function (fm) {
      fm.addEventListener("submit", function (e) {
        e.preventDefault();
        var id = fm.dataset.runf, btn = fm.querySelector("button");
        btn.disabled = true;
        api("/video/" + id + "/run", "POST", { course_id: +fm.querySelector("select").value, time: fm.querySelector('[data-k="time"]').value, pen: fm.querySelector('[data-k="pen"]').value, dq: fm.querySelector('[data-k="dq"]').checked }).then(function (st) {
          S = st;
          var x = (S.videos || []).filter(function (v) { return String(v.id) === String(id); })[0];
          var el = root.querySelector('[data-run="' + id + '"]');
          if (x && el) { var info = runInfo(x); el.innerHTML = info; el.hidden = !info; }
          btn.disabled = false;
          fm.closest("details").open = false;
          toast(x && x.run_time ? "Сохранено: " + fmtTime(x.run_time) : "Сохранено.");
        }, function (err) { btn.disabled = false; toast(err.message); });
      });
    });
    Array.prototype.forEach.call(scope.querySelectorAll("button[data-me]"), function (b) {
      b.addEventListener("click", function () { toggleMe(b.dataset.me, b); });
    });
    Array.prototype.forEach.call(scope.querySelectorAll("button[data-fav]"), function (b) {
      b.addEventListener("click", function () {
        toggleMe(b.dataset.fav, b, "/fav", function (x) { return x.fav ? "Добавлено в избранное." : "Убрано из избранного."; });
      });
    });
    Array.prototype.forEach.call(scope.querySelectorAll("button[data-dv]"), function (b) { armOne(b, "dv", function (id) { return act("/videos/" + id, "DELETE"); }); });
    Array.prototype.forEach.call(scope.querySelectorAll("button[data-mark]"), function (b) {
      b.addEventListener("click", function () {
        toggleMe(b.dataset.mark, b, "/delete", function (x) {
          return x.marked ? "Видео помечено: удалится через " + x.days_left + " " + plural(x.days_left, "день", "дня", "дней") + ". Пометку можно снять." : "Удаление отменено.";
        });
      });
    });
  }

  function armOne(b, attr, fn) {
    b.addEventListener("click", function () {
      if (b.dataset.armed) { fn(b.getAttribute("data-" + attr)).catch(function () {}); return; }
      b.dataset.armed = "1"; b.textContent = "Точно удалить?";
      setTimeout(function () { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Удалить"; } }, 3000);
    });
  }

  function markedCount(list) { return list.filter(function (x) { return x.marked; }).length; }

  /* Страница одного видео (из заметок) */
  var openVideo = null, backTo = null;
  try { var hv = /^#v-(\d+)(?:-([\d.]+))?$/.exec(location.hash); if (hv) { openVideo = hv[1]; tab = "video"; if (hv[2]) pendingSeek = { id: hv[1], t: +hv[2] }; } } catch (e) {}
  function showVideo(id, t, from) {
    openVideo = String(id); backTo = from || null; tab = "video";
    pendingSeek = t != null ? { id: String(id), t: t } : null;
    try { history.replaceState(null, "", "#v-" + id + (t != null ? "-" + t : "")); } catch (e) {}
    render(); window.scrollTo(0, 0);
  }
  function viewOneVideo(v, x) {
    var a = S.role === "admin", logged = !!S.user;
    var wasBig = bigView; bigView = true;
    var item = videoItem(x, a, logged);
    bigView = wasBig;
    v.innerHTML = '<div class="row" style="gap:8px;align-items:center">' +
      (backTo === "notes" ? '<button type="button" class="btn small ghost" data-back1="notes">← Заметки</button>' : "") +
      '<button type="button" class="btn small ghost" data-back1="day">← Все видео ' + esc(fmtDate(x.date)) + "</button></div>" +
      "<h1 data-onetitle>" + esc(x.label || x.title) + "</h1>" +
      '<section class="panel acl-vbig">' + item + "</section>";
    qa("button[data-back1]").forEach(function (b) {
      b.addEventListener("click", function () {
        openVideo = null; pendingSeek = null;
        if (b.dataset.back1 === "notes") { tab = "notes"; try { history.replaceState(null, "", "#notes"); } catch (e) {} render(); window.scrollTo(0, 0); }
        else setVideoDate(x.date);
      });
    });
    bindVideoButtons(v);
    if (pendingSeek && String(pendingSeek.id) === String(x.id)) {
      var ps = pendingSeek; pendingSeek = null;
      var pv = v.querySelector("video");
      if (pv) {
        var go = function () { frameMode(pv, true); pv.currentTime = ps.t; };
        if (pv.readyState >= 1) go(); else pv.addEventListener("loadedmetadata", go, { once: true });
      }
    }
  }

  function viewVideo(v) {
    if (openVideo) {
      var one = (S.videos || []).filter(function (y) { return String(y.id) === String(openVideo); })[0];
      if (one) { viewOneVideo(v, one); return; }
      openVideo = null;
    }
    var a = S.role === "admin";
    var logged = !!S.user;
    var all = S.videos || [];
    var onlyMine = logged && vFilter !== "all";
    var shown = onlyMine ? all.filter(passes) : all;
    var byDate = {};
    shown.forEach(function (x) { (byDate[x.date] = byDate[x.date] || []).push(x); });
    var dates = Object.keys(byDate).sort().reverse();
    if (openDate && !byDate[openDate]) openDate = null;

    var filter = logged
      ? '<div class="row" style="gap:8px" role="group" aria-label="Какие видео показать">' +
        ["all", "mine", "fav"].map(function (k) { return '<button type="button" class="btn small ' + (vFilter === k ? "" : "ghost") + '" data-filter="' + k + '">' + filterLabels()[k] + "</button>"; }).join("") + "</div>"
      : "";
    var lead = a ? "Видео загружаются с телефона приложением «Сжатие видео». Ссылку на ролик в ВК или Rutube можно добавить и вручную."
      : logged ? "Нажмите «Это я» под своими роликами — потом их легко найти кнопкой «Только мои», а лучшие — ⭐ в избранное. Ненужное отметьте «Удалить»: видео сотрётся через " + (+(S.video_days || 30)) + " " + plural(+(S.video_days || 30), "день", "дня", "дней") + ", до этого пометку можно снять."
      : "Записи тренировок по дням. Войдите, чтобы отмечать свои видео.";
    var html;

    if (openDate) {
      // ---- один день
      var list = byDate[openDate], total = 0;
      list.forEach(function (x) { total += +x.size || 0; });
      var daySes = (S.sessions || []).filter(function (x) { return x.date === openDate; })[0];
      var dayCourses = daySes && S.courses ? coursesFor(daySes.id) : [];
      html = '<div class="row" style="gap:8px;align-items:center"><button type="button" class="btn small ghost" data-back="1">← Все дни</button>' +
        (daySes && S.courses ? '<button type="button" class="btn small ghost" data-dayses="' + daySes.id + '">Схема трассы' + (dayCourses.length === 1 ? "" : "ы (" + dayCourses.length + ")") + " →</button>" : "") + "</div>" +
        (dayCourses.length ? '<div class="acl-cthumbs">' + dayCourses.map(function (c) { return courseThumb(c, daySes.id); }).join("") + "</div>" : "") +
        '<div class="row" style="justify-content:space-between;align-items:center"><h1>' + esc(fmtDate(openDate)) + '</h1>' +
        (a && !onlyMine ? '<button type="button" class="btn small danger" data-dday="' + openDate + '">Удалить весь день</button>' : "") + "</div>" +
        '<p class="lead">' + list.length + " видео" + (total ? " · " + mb(total) : "") + (onlyMine ? (vFilter === "fav" ? " · избранное" : " · только мои") : "") + (markedCount(list) ? " · к удалению: " + markedCount(list) : "") + "</p>" + filter +
        '<div class="row" style="gap:8px" role="group" aria-label="Размер видео">' +
        '<button type="button" class="btn small ' + (bigView ? "" : "ghost") + '" data-view="big">Крупно</button>' +
        '<button type="button" class="btn small ' + (bigView ? "ghost" : "") + '" data-view="small">Плиткой</button></div>' +
        '<section class="panel ' + (bigView ? "acl-vbig" : "acl-vsmall") + '">' + list.map(function (x) { return videoItem(x, a, logged); }).join("") + "</section>";
    } else {
      // ---- список дней
      var months = {};
      dates.forEach(function (d) { (months[d.slice(0, 7)] = months[d.slice(0, 7)] || []).push(d); });
      var cards = Object.keys(months).sort().reverse().map(function (m) {
        var p = m.split("-");
        var title = new Date(+p[0], +p[1] - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
        return "<h2 style=\"text-transform:capitalize\">" + esc(title) + '</h2><div class="cards">' + months[m].map(function (d) {
          var list = byDate[d], total = 0, mine = 0;
          var fv = 0;
          list.forEach(function (x) { total += +x.size || 0; if (x.mine) mine++; if (x.fav) fv++; });
          return '<button type="button" class="slot" data-day="' + d + '" style="text-align:left;cursor:pointer;font:inherit;color:inherit">' +
            '<span class="d">' + esc(fmtDate(d)) + "</span>" +
            '<span class="t">' + list.length + " видео" + (total ? " · " + mb(total) : "") + "</span>" +
            (markedCount(list) ? '<span class="who">к удалению: ' + markedCount(list) + "</span>" : "") +
            (logged && mine ? '<span class="pill ok" style="justify-self:start">мои: ' + mine + (fv ? " · ⭐ " + fv : "") + "</span>" : "") + "</button>";
        }).join("") + "</div>";
      }).join("");
      var empty = onlyMine && vFilter === "fav"
        ? '<div class="panel empty">В избранном пока пусто. Под своими видео (где стоит «Это я») нажмите «☆ В избранное».</div>'
        : onlyMine
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
    qa("button[data-dayses]").forEach(function (b) {
      b.addEventListener("click", function () { openDate = null; setSession(+b.dataset.dayses); window.scrollTo(0, 0); });
    });
    qa("button[data-filter]").forEach(function (b) {
      b.addEventListener("click", function () {
        vFilter = b.dataset.filter;
        try { localStorage.setItem("acl-vfilter", vFilter); } catch (e) {}
        render();
      });
    });
    bindVideoButtons(v);
    qa("button[data-view]").forEach(function (b) {
      b.addEventListener("click", function () {
        bigView = b.dataset.view === "big";
        try { localStorage.setItem("acl-video-view", bigView ? "big" : "small"); } catch (e) {}
        render();
      });
    });
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
      '<label for="c-disc">Скидка организатору, ₽<input type="number" id="c-disc" value="' + st.org_discount + '" step="50"></label>' +
      '<label for="c-vdays" title="Через сколько дней стирается видео, помеченное «Удалить»">Удаление видео, дней<input type="number" id="c-vdays" value="' + (st.video_days == null ? 30 : st.video_days) + '" min="1"></label></div>' +
      '<label for="c-mem">Участники, по одному в строке (собака владельца — отдельной строкой). Удалённые из списка скрываются, их история сохраняется.<textarea id="c-mem">' + esc(mem.map(function (m) { return m.name; }).join("\n")) + "</textarea></label>" +
      '<div class="row"><button class="btn">Сохранить</button></div></form>' +
      '<section class="panel" style="display:grid;gap:10px"><h2>Письма участникам</h2>' +
      '<p class="note">Когда вы добавляете тренировку или кто-то предлагает трассу на будущую тренировку, всем зарегистрированным пользователям сайта уходит письмо. Если за 2 минуты добавлено несколько — придёт одно общее письмо. Автору о его же записи не пишем. Каждый может отписаться ссылкой из письма или галочкой во вкладке «Мои тренировки».</p>' +
      '<label style="display:flex;gap:8px;align-items:center;color:var(--fg)"><input type="checkbox" id="acl-notify-all"' + (st.notify == null || +st.notify ? " checked" : "") + "> Рассылать письма о новых тренировках и трассах</label>" +
      notifyBox() +
      (S.notify_last ? '<div class="status">Последняя рассылка: ' + esc(S.notify_last.time) + " · отправлено писем: " + S.notify_last.sent + "</div>" : '<div class="status">Рассылок ещё не было.</div>') +
      "</section>";

    var na = q("#acl-notify-all");
    if (na) na.addEventListener("change", function () {
      na.disabled = true;
      api("/settings", "POST", { notify: na.checked ? 1 : 0 }).then(function (st2) { S = st2; na.disabled = false; toast(na.checked ? "Рассылка включена." : "Рассылка выключена для всех."); },
        function (e) { na.disabled = false; na.checked = !na.checked; toast(e.message); });
    });
    bindNotify();

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
        org_shares: +q("#c-shares").value, org_discount: +q("#c-disc").value, video_days: +q("#c-vdays").value, organizer: q("#c-org").value.trim(), members: list
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
    // Не перерисовываем, пока заполняют форму трассы или голос — иначе введённое пропадёт
    var img = root.querySelector("#cf-img"), ttl = root.querySelector("#cf-title");
    if ((img && img.files && img.files.length) || (ttl && ttl.value)) return;
    if (Array.prototype.some.call(root.querySelectorAll("textarea"), function (t) { return t.value !== t.defaultValue; })) return;
    if (Array.prototype.some.call(root.querySelectorAll("form[data-runf] input, form[data-cedit] input, #cf-len"), function (t) { return t.type === "checkbox" ? t.checked !== t.defaultChecked : t.value !== t.defaultValue; })) return;
    if (root.querySelector("details[open] [data-timer], details[open][data-notef]")) return;
    if (Array.prototype.some.call(root.querySelectorAll("form[data-runf] select"), function (sl) { return Array.prototype.some.call(sl.options, function (o) { return o.selected !== o.defaultSelected; }); })) return;
    // Не перерисовываем, пока смотрят видео — иначе ролик остановится
    if (Array.prototype.some.call(root.querySelectorAll("video"), function (vd) { return (!vd.paused && !vd.ended) || vd.currentTime > 0; })) return;
    api("/state").then(function (st) { S = st; render(); }).catch(function () {});
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  window.addEventListener("focus", refresh);
  setInterval(function () { if (!document.hidden) refresh(); }, 60000);
})();
