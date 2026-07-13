const app = document.querySelector('#app');
const toast = document.querySelector('#toast');

const state = {
  token: localStorage.getItem('quizToken') || '',
  user: null,
  quizzes: [],
  history: [],
  view: 'dashboard',
  editor: null,
  room: null,
  ws: null,
  wsRoomCode: '',
};

bootstrap();

document.addEventListener('submit', handleSubmit);
document.addEventListener('click', handleClick);
document.addEventListener('input', handleEditorInput);
document.addEventListener('change', handleEditorInput);

setInterval(updateCountdowns, 500);

async function bootstrap() {
  if (!state.token) {
    render();
    return;
  }

  try {
    const data = await api('/api/me');
    state.user = data.user;
    await refreshWorkspaceData();
  } catch {
    localStorage.removeItem('quizToken');
    state.token = '';
    state.user = null;
  }

  render();
}

async function refreshWorkspaceData() {
  if (!state.user) {
    return;
  }

  const [quizzesData, historyData] = await Promise.all([
    api('/api/quizzes'),
    api('/api/history'),
  ]);

  state.quizzes = quizzesData.quizzes || [];
  state.history = historyData.history || [];
}

async function handleSubmit(event) {
  const form = event.target;

  if (!form.dataset.form) {
    return;
  }

  event.preventDefault();

  try {
    if (form.dataset.form === 'login') {
      const formData = new FormData(form);
      const data = await api('/api/login', {
        method: 'POST',
        body: {
          email: formData.get('email'),
          password: formData.get('password'),
        },
      });
      await completeAuth(data);
      showToast('Вы вошли в систему', 'success');
    }

    if (form.dataset.form === 'register') {
      const formData = new FormData(form);
      const data = await api('/api/register', {
        method: 'POST',
        body: {
          name: formData.get('name'),
          email: formData.get('email'),
          password: formData.get('password'),
          role: formData.get('role'),
        },
      });
      await completeAuth(data);
      showToast('Аккаунт создан', 'success');
    }

    if (form.dataset.form === 'join-room') {
      const formData = new FormData(form);
      const code = String(formData.get('code') || '').trim().toUpperCase();
      await joinRoom(code);
    }

    if (form.dataset.form === 'answer') {
      const selectedOptionIds = [...form.querySelectorAll('input[name="answer"]:checked')].map(
        (input) => input.value,
      );
      const data = await api(`/api/rooms/${state.room.code}/answer`, {
        method: 'POST',
        body: { selectedOptionIds },
      });
      state.room = data.room;
      render();
      showToast(data.result.isCorrect ? 'Ответ принят: верно' : 'Ответ принят', 'success');
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleClick(event) {
  const button = event.target.closest('[data-action]');

  if (!button) {
    return;
  }

  const action = button.dataset.action;

  try {
    if (action === 'logout') {
      await api('/api/logout', { method: 'POST' }).catch(() => null);
      localStorage.removeItem('quizToken');
      closeWs();
      Object.assign(state, {
        token: '',
        user: null,
        quizzes: [],
        history: [],
        view: 'dashboard',
        editor: null,
        room: null,
      });
      render();
      return;
    }

    if (action === 'dashboard') {
      state.view = 'dashboard';
      state.editor = null;
      await refreshWorkspaceData();
      render();
      return;
    }

    if (action === 'history') {
      state.view = 'history';
      await refreshWorkspaceData();
      render();
      return;
    }

    if (action === 'new-quiz') {
      state.editor = emptyQuiz();
      state.view = 'editor';
      render();
      return;
    }

    if (action === 'edit-quiz') {
      const data = await api(`/api/quizzes/${button.dataset.id}`);
      state.editor = structuredClone(data.quiz);
      state.view = 'editor';
      render();
      return;
    }

    if (action === 'save-quiz') {
      await saveQuiz();
      return;
    }

    if (action === 'add-question') {
      state.editor.questions.push(emptyQuestion());
      render();
      return;
    }

    if (action === 'remove-question') {
      state.editor.questions.splice(Number(button.dataset.q), 1);
      if (state.editor.questions.length === 0) {
        state.editor.questions.push(emptyQuestion());
      }
      render();
      return;
    }

    if (action === 'add-option') {
      state.editor.questions[Number(button.dataset.q)].options.push(emptyOption(false));
      render();
      return;
    }

    if (action === 'remove-option') {
      const question = state.editor.questions[Number(button.dataset.q)];
      question.options.splice(Number(button.dataset.o), 1);
      if (question.options.length < 2) {
        question.options.push(emptyOption(false));
      }
      ensureQuestionCorrectness(question);
      render();
      return;
    }

    if (action === 'start-quiz') {
      const data = await api(`/api/quizzes/${button.dataset.id}/start`, { method: 'POST' });
      state.room = data.room;
      state.view = 'room';
      connectWs(state.room.code);
      await refreshWorkspaceData();
      render();
      showToast(`Комната ${state.room.code} создана`, 'success');
      return;
    }

    if (action === 'copy-code') {
      await navigator.clipboard.writeText(state.room.code);
      showToast('Код комнаты скопирован', 'success');
      return;
    }

    if (action === 'next-question') {
      const data = await api(`/api/rooms/${state.room.code}/next`, { method: 'POST' });
      state.room = data.room;
      render();
      return;
    }

    if (action === 'finish-room') {
      const data = await api(`/api/rooms/${state.room.code}/finish`, { method: 'POST' });
      state.room = data.room;
      await refreshWorkspaceData();
      render();
      return;
    }

    if (action === 'leave-room') {
      closeWs();
      state.room = null;
      state.view = 'dashboard';
      await refreshWorkspaceData();
      render();
      return;
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function handleEditorInput(event) {
  const input = event.target;

  if (!state.editor || !input.dataset.editorField) {
    return;
  }

  const field = input.dataset.editorField;
  const qIndex = input.dataset.q === undefined ? null : Number(input.dataset.q);
  const oIndex = input.dataset.o === undefined ? null : Number(input.dataset.o);

  if (qIndex === null) {
    state.editor[field] = input.type === 'number' ? Number(input.value) : input.value;
    return;
  }

  const question = state.editor.questions[qIndex];

  if (!question) {
    return;
  }

  if (oIndex !== null) {
    const option = question.options[oIndex];

    if (!option) {
      return;
    }

    if (field === 'optionText') {
      option.text = input.value;
    }

    if (field === 'correct') {
      if (question.answerMode === 'single') {
        question.options.forEach((item, index) => {
          item.correct = index === oIndex;
        });
      } else {
        option.correct = input.checked;
      }
    }
    return;
  }

  if (field === 'points') {
    question.points = Number(input.value);
    return;
  }

  if (field === 'answerMode') {
    question.answerMode = input.value;
    ensureQuestionCorrectness(question);
    render();
    return;
  }

  if (field === 'type') {
    question.type = input.value;
    if (question.type === 'text') {
      question.imageUrl = '';
    }
    render();
    return;
  }

  question[field] = input.value;
}

async function completeAuth(data) {
  state.user = data.user;
  state.token = data.token;
  localStorage.setItem('quizToken', data.token);
  state.view = 'dashboard';
  await refreshWorkspaceData();
  render();
}

async function saveQuiz() {
  const isExisting = Boolean(state.editor.id);
  const data = await api(isExisting ? `/api/quizzes/${state.editor.id}` : '/api/quizzes', {
    method: isExisting ? 'PUT' : 'POST',
    body: state.editor,
  });

  state.editor = null;
  state.view = 'dashboard';
  await refreshWorkspaceData();
  render();
  showToast(`Квиз «${data.quiz.title}» сохранён`, 'success');
}

async function joinRoom(code) {
  if (!code) {
    showToast('Введите код комнаты', 'error');
    return;
  }

  const data = await api(`/api/rooms/${code}/join`, { method: 'POST' });
  state.room = data.room;
  state.view = 'room';
  connectWs(state.room.code);
  render();
  showToast(`Вы подключились к комнате ${state.room.code}`, 'success');
}

function connectWs(roomCode) {
  if (!state.token || !roomCode) {
    return;
  }

  if (state.ws && state.wsRoomCode === roomCode && state.ws.readyState <= 1) {
    return;
  }

  closeWs();

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${protocol}://${location.host}/ws?token=${encodeURIComponent(state.token)}&room=${encodeURIComponent(roomCode)}`,
  );

  state.ws = ws;
  state.wsRoomCode = roomCode;

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);

    if (message.type === 'room:update') {
      state.room = message.payload;
      if (state.view !== 'room') {
        state.view = 'room';
      }
      render();
    }
  });

  ws.addEventListener('close', () => {
    if (state.room?.code === roomCode && state.room?.status !== 'finished') {
      setTimeout(() => connectWs(roomCode), 1200);
    }
  });
}

function closeWs() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }

  state.ws = null;
  state.wsRoomCode = '';
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
  };

  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Запрос не выполнен');
  }

  return data;
}

function render() {
  if (!state.user) {
    app.innerHTML = renderAuth();
    return;
  }

  app.innerHTML = `
    <div class="shell">
      ${renderTopbar()}
      <main class="content">
        ${renderCurrentView()}
      </main>
    </div>
  `;

  if (state.room && state.view === 'room') {
    connectWs(state.room.code);
  }
}

function renderAuth() {
  return `
    <main class="auth-page">
      <section class="auth-hero">
        <div class="auth-header">
          <div class="brand"><span class="brand-mark">Q</span><span>QuizRoom MVP</span></div>
          <span class="eyebrow">Live quiz platform</span>
          <h1>Квизы, которые выглядят как настоящее шоу</h1>
          <p>Организатор запускает комнату, участники входят по коду, вопросы появляются синхронно, а итоговый лидерборд сохраняется в истории.</p>
          <div class="hero-metrics">
            <div class="hero-metric"><strong>6</strong><span>символов в коде комнаты</span></div>
            <div class="hero-metric"><strong>2</strong><span>типа вопросов</span></div>
            <div class="hero-metric"><strong>live</strong><span>обновления через WebSocket</span></div>
          </div>
        </div>
        <aside class="auth-showcase" aria-label="Пример экрана квиза">
          <div class="showcase-top">
            <div class="showcase-dots"><span></span><span></span><span></span></div>
            <span class="tag good">Комната Q7M4X2</span>
          </div>
          <div class="stage-card">
            <div class="actions">
              <span class="tag">Вопрос 3 из 8</span>
              <span class="timer">18s</span>
            </div>
            <h2>Какой протокол используют для обмена событиями в реальном времени?</h2>
            <div class="stage-options">
              <div class="stage-option is-live"><span>WebSocket</span><strong>64%</strong></div>
              <div class="stage-option"><span>FTP</span><strong>12%</strong></div>
              <div class="stage-option"><span>SMTP</span><strong>8%</strong></div>
              <div class="stage-option"><span>POP3</span><strong>16%</strong></div>
            </div>
          </div>
          <section class="auth-grid">
            <form class="panel" data-form="login">
              <div class="panel-inner form-grid">
                <h2>Вход</h2>
                <label>Email
                  <input name="email" type="email" value="organizer@example.com" required />
                </label>
                <label>Пароль
                  <input name="password" type="password" value="demo1234" required />
                </label>
                <button type="submit">Войти</button>
                <p class="muted">Демо: organizer@example.com / demo1234</p>
              </div>
            </form>
            <form class="panel" data-form="register">
              <div class="panel-inner form-grid">
                <h2>Регистрация</h2>
                <label>Имя
                  <input name="name" required />
                </label>
                <label>Email
                  <input name="email" type="email" required />
                </label>
                <label>Пароль
                  <input name="password" type="password" minlength="6" required />
                </label>
                <label>Роль
                  <select name="role">
                    <option value="participant">Участник</option>
                    <option value="organizer">Организатор</option>
                  </select>
                </label>
                <button type="submit">Создать</button>
              </div>
            </form>
          </section>
        </aside>
      </section>
    </main>
  `;
}

function renderTopbar() {
  const organizer = state.user.role === 'organizer';

  return `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">Q</span><span>QuizRoom MVP</span></div>
      <nav class="nav">
        <button class="button-secondary" type="button" data-action="dashboard">Кабинет</button>
        ${
          organizer
            ? '<button class="button-secondary" type="button" data-action="new-quiz">Новый квиз</button>'
            : ''
        }
        <button class="button-secondary" type="button" data-action="history">История</button>
      </nav>
      <div class="userbar">
        <span class="pill">${escapeHtml(state.user.name)} · ${roleName(state.user.role)}</span>
        <button class="button-ghost" type="button" data-action="logout">Выйти</button>
      </div>
    </header>
  `;
}

function renderCurrentView() {
  if (state.view === 'editor') {
    return renderEditor();
  }

  if (state.view === 'room' && state.room) {
    return renderRoom();
  }

  if (state.view === 'history') {
    return renderHistory();
  }

  return state.user.role === 'organizer' ? renderOrganizerDashboard() : renderParticipantDashboard();
}

function renderOrganizerDashboard() {
  const finishedRooms = state.history.filter((item) => item.status === 'finished').length;
  const totalParticipants = state.history.reduce((sum, item) => sum + item.participantsCount, 0);

  return `
    <section class="dashboard-hero">
      <div>
        <span class="eyebrow">Organizer cockpit</span>
        <h1>Кабинет организатора</h1>
        <p>Создавайте квизы, запускайте комнаты и следите за ответами участников в реальном времени.</p>
      </div>
      <div class="actions">
        <button type="button" data-action="new-quiz">Создать квиз</button>
      </div>
    </section>
    <section class="stat-grid">
      <div class="stat"><strong>${state.quizzes.length}</strong><span>квизов создано</span></div>
      <div class="stat"><strong>${state.history.length}</strong><span>запусков проведено</span></div>
      <div class="stat"><strong>${finishedRooms || totalParticipants}</strong><span>${finishedRooms ? 'квизов завершено' : 'участников всего'}</span></div>
    </section>
    <div class="split-line"></div>
    <section class="grid two">
      <div>
        <div class="section-heading"><h2>Мои квизы</h2><span class="tag">готово к запуску</span></div>
        <div class="list">
          ${
            state.quizzes.length
              ? state.quizzes.map(renderQuizCard).join('')
              : '<div class="empty">Пока нет квизов. Создайте первый сценарий для демонстрации MVP.</div>'
          }
        </div>
      </div>
      <aside class="panel">
        <div class="panel-inner">
          <h3>Быстрый запуск</h3>
          <p class="muted">После запуска появится код комнаты. Участники вводят его в своём кабинете и получают вопросы синхронно через WebSocket.</p>
          <div class="split-line"></div>
          ${renderRecentHistory(3)}
        </div>
      </aside>
    </section>
  `;
}

function renderParticipantDashboard() {
  return `
    <section class="dashboard-hero">
      <div>
        <span class="eyebrow">Player room</span>
        <h1>Кабинет участника</h1>
        <p>Подключайтесь к активному квизу по коду комнаты и отвечайте только пока вопрос открыт.</p>
      </div>
    </section>
    <section class="grid two">
      <form class="panel" data-form="join-room">
        <div class="panel-inner form-grid">
          <h2>Подключиться</h2>
          <label>Код комнаты
            <input name="code" placeholder="Например, A7K9Q2" maxlength="6" required />
          </label>
          <button type="submit">Войти в комнату</button>
        </div>
      </form>
      <aside class="panel">
        <div class="panel-inner">
          <h3>Моя история</h3>
          ${renderRecentHistory(4)}
        </div>
      </aside>
    </section>
  `;
}

function renderQuizCard(quiz) {
  return `
    <article class="card">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(quiz.title)}</h3>
          <p>${escapeHtml(quiz.description || 'Без описания')}</p>
          <div class="meta">
            <span class="tag">${escapeHtml(quiz.category)}</span>
            <span class="tag">${quiz.questionCount} ${pluralRu(quiz.questionCount, 'вопрос', 'вопроса', 'вопросов')}</span>
            <span class="tag">${quiz.questionTimeLimit} сек.</span>
          </div>
        </div>
        <div class="actions">
          <button class="button-secondary" type="button" data-action="edit-quiz" data-id="${quiz.id}">Редактировать</button>
          <button type="button" data-action="start-quiz" data-id="${quiz.id}">Запустить</button>
        </div>
      </div>
    </article>
  `;
}

function renderEditor() {
  if (!state.editor) {
    state.editor = emptyQuiz();
  }

  return `
    <section class="page-title">
      <div>
        <h1>${state.editor.id ? 'Редактирование квиза' : 'Новый квиз'}</h1>
        <p>Настройте категорию, время ответа, правила и вопросы. Поддерживаются текстовые задания и задания с изображением.</p>
      </div>
      <div class="actions">
        <button class="button-secondary" type="button" data-action="dashboard">Отмена</button>
        <button type="button" data-action="save-quiz">Сохранить</button>
      </div>
    </section>
    <section class="editor">
      <div class="panel">
        <div class="panel-inner form-grid">
          <div class="form-grid two">
            <label>Название
              <input data-editor-field="title" value="${escapeAttr(state.editor.title)}" required />
            </label>
            <label>Категория
              <input data-editor-field="category" value="${escapeAttr(state.editor.category)}" required />
            </label>
          </div>
          <label>Описание
            <textarea data-editor-field="description">${escapeHtml(state.editor.description || '')}</textarea>
          </label>
          <div class="form-grid two">
            <label>Время на вопрос, сек.
              <input data-editor-field="questionTimeLimit" type="number" min="10" max="180" value="${state.editor.questionTimeLimit}" />
            </label>
            <label>Правила
              <input data-editor-field="rules" value="${escapeAttr(state.editor.rules || '')}" />
            </label>
          </div>
        </div>
      </div>
      ${state.editor.questions.map(renderQuestionEditor).join('')}
      <div class="actions">
        <button class="button-secondary" type="button" data-action="add-question">Добавить вопрос</button>
        <button type="button" data-action="save-quiz">Сохранить квиз</button>
      </div>
    </section>
  `;
}

function renderQuestionEditor(question, qIndex) {
  return `
    <article class="question-card">
      <div class="question-top">
        <h2>Вопрос ${qIndex + 1}</h2>
        <button class="button-danger" type="button" data-action="remove-question" data-q="${qIndex}">Удалить</button>
      </div>
      <div class="form-grid two">
        <label>Тип вопроса
          <select data-editor-field="type" data-q="${qIndex}">
            <option value="text" ${question.type === 'text' ? 'selected' : ''}>Текст</option>
            <option value="image" ${question.type === 'image' ? 'selected' : ''}>Изображение</option>
          </select>
        </label>
        <label>Тип ответа
          <select data-editor-field="answerMode" data-q="${qIndex}">
            <option value="single" ${question.answerMode === 'single' ? 'selected' : ''}>Один вариант</option>
            <option value="multiple" ${question.answerMode === 'multiple' ? 'selected' : ''}>Несколько вариантов</option>
          </select>
        </label>
      </div>
      <label>Текст задания
        <textarea data-editor-field="prompt" data-q="${qIndex}">${escapeHtml(question.prompt || '')}</textarea>
      </label>
      ${
        question.type === 'image'
          ? `<label>Ссылка на изображение
              <input data-editor-field="imageUrl" data-q="${qIndex}" value="${escapeAttr(question.imageUrl || '')}" placeholder="https://..." />
            </label>`
          : ''
      }
      <label>Баллы
        <input data-editor-field="points" data-q="${qIndex}" type="number" min="1" max="100" value="${question.points || 1}" />
      </label>
      <div class="list">
        ${question.options.map((option, oIndex) => renderOptionEditor(question, option, qIndex, oIndex)).join('')}
      </div>
      <div class="actions">
        <button class="button-secondary" type="button" data-action="add-option" data-q="${qIndex}">Добавить вариант</button>
      </div>
    </article>
  `;
}

function renderOptionEditor(question, option, qIndex, oIndex) {
  const inputType = question.answerMode === 'single' ? 'radio' : 'checkbox';

  return `
    <div class="option-row">
      <input
        type="${inputType}"
        name="correct-${qIndex}"
        data-editor-field="correct"
        data-q="${qIndex}"
        data-o="${oIndex}"
        ${option.correct ? 'checked' : ''}
        aria-label="Правильный ответ"
      />
      <input
        data-editor-field="optionText"
        data-q="${qIndex}"
        data-o="${oIndex}"
        value="${escapeAttr(option.text || '')}"
        placeholder="Вариант ответа"
      />
      <button class="button-ghost" type="button" data-action="remove-option" data-q="${qIndex}" data-o="${oIndex}">Удалить</button>
    </div>
  `;
}

function renderRoom() {
  const room = state.room;
  const questionNumber = room.currentQuestionIndex + 1;

  return `
    <section class="page-title">
      <div>
        <span class="eyebrow">${room.status === 'finished' ? 'Final results' : room.status === 'lobby' ? 'Live lobby' : 'Live question'}</span>
        <h1>${escapeHtml(room.quiz.title)}</h1>
        <p>${escapeHtml(room.quiz.rules || '')}</p>
      </div>
      <div class="actions">
        <span class="room-code">${room.code}</span>
        <button class="button-secondary" type="button" data-action="copy-code">Копировать</button>
        <button class="button-ghost" type="button" data-action="leave-room">В кабинет</button>
      </div>
    </section>
    <section class="room-layout">
      <div>
        <div class="question-display">
          ${
            room.status === 'lobby'
              ? renderLobby(room)
              : room.status === 'finished'
                ? renderFinished(room)
                : renderActiveQuestion(room, questionNumber)
          }
        </div>
      </div>
      <aside class="grid">
        ${room.isOrganizer ? renderOrganizerControls(room) : ''}
        ${renderParticipants(room)}
        ${renderLeaderboard(room)}
      </aside>
    </section>
  `;
}

function renderLobby(room) {
  return `
    <div>
      <span class="tag warn">Ожидание участников</span>
      <h2>Комната готова</h2>
      <p class="muted">Код комнаты уже можно отправлять участникам. Первый вопрос появится у всех одновременно после запуска.</p>
    </div>
    ${
      room.isOrganizer
        ? '<div class="actions"><button type="button" data-action="next-question">Показать первый вопрос</button></div>'
        : '<p class="muted">Дождитесь, когда организатор покажет первый вопрос.</p>'
    }
  `;
}

function renderActiveQuestion(room, questionNumber) {
  const question = room.currentQuestion;
  const answered = Boolean(room.myAnswer);
  const inputType = question.answerMode === 'single' ? 'radio' : 'checkbox';
  const correctIds = new Set(
    question.options.filter((option) => option.correct).map((option) => option.id),
  );

  return `
    <div class="actions">
      <span class="tag">Вопрос ${questionNumber} из ${room.totalQuestions}</span>
      <span class="tag">${question.answerMode === 'single' ? 'один ответ' : 'несколько ответов'}</span>
      <span class="tag">${question.points} ${pluralRu(question.points, 'балл', 'балла', 'баллов')}</span>
      <span class="timer" data-countdown="${room.questionEndsAt || ''}">--</span>
    </div>
    <h2>${escapeHtml(question.prompt)}</h2>
    ${
      question.type === 'image'
        ? `<img class="question-image" src="${escapeAttr(question.imageUrl)}" alt="Изображение к вопросу" />`
        : ''
    }
    ${
      room.isOrganizer
        ? renderOrganizerQuestionOptions(question, correctIds)
        : renderParticipantAnswerForm(question, inputType, answered, room.myAnswer)
    }
  `;
}

function renderOrganizerQuestionOptions(question, correctIds) {
  return `
    <div class="answer-list">
      ${question.options
        .map(
          (option) => `
            <div class="answer-option ${correctIds.has(option.id) ? 'correct' : ''}">
              <span>${correctIds.has(option.id) ? '✓' : '•'}</span>
              <span>${escapeHtml(option.text)}</span>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderParticipantAnswerForm(question, inputType, answered, myAnswer) {
  if (answered) {
    return `
      <div class="answer-list">
        ${question.options
          .map(
            (option) => `
              <div class="answer-option ${myAnswer.selectedOptionIds.includes(option.id) ? 'correct' : ''}">
                <span>${myAnswer.selectedOptionIds.includes(option.id) ? '✓' : '•'}</span>
                <span>${escapeHtml(option.text)}</span>
              </div>
            `,
          )
          .join('')}
      </div>
      <p class="muted">Ответ отправлен. Начислено баллов: ${myAnswer.points}.</p>
    `;
  }

  return `
    <form class="form-grid" data-form="answer">
      <div class="answer-list">
        ${question.options
          .map(
            (option) => `
              <label class="answer-option">
                <input type="${inputType}" name="answer" value="${option.id}" />
                <span>${escapeHtml(option.text)}</span>
              </label>
            `,
          )
          .join('')}
      </div>
      <button class="js-answer-submit" type="submit">Отправить ответ</button>
    </form>
  `;
}

function renderFinished(room) {
  const winner = room.leaderboard[0];

  return `
    <div>
      <span class="tag good">Квиз завершён</span>
      <h2>${winner ? `Победитель: ${escapeHtml(winner.name)}` : 'Победитель не определён'}</h2>
      <p class="muted">Результаты сохранены в истории организатора и участников.</p>
    </div>
    ${renderLeaderboard(room)}
  `;
}

function renderOrganizerControls(room) {
  return `
    <div class="panel">
      <div class="panel-inner form-grid">
        <h3>Управление</h3>
        <div class="actions">
          ${
            room.status === 'finished'
              ? ''
              : `<button type="button" data-action="next-question">${room.status === 'lobby' ? 'Первый вопрос' : 'Следующий вопрос'}</button>
                 <button class="button-danger" type="button" data-action="finish-room">Завершить</button>`
          }
        </div>
        ${
          room.answerStats
            ? `<p class="muted">Ответили: ${room.answerStats.submittedCount} из ${room.participants.length}</p>`
            : '<p class="muted">Участники появятся здесь после подключения.</p>'
        }
      </div>
    </div>
  `;
}

function renderParticipants(room) {
  return `
    <div class="panel">
      <div class="panel-inner">
        <h3>Участники</h3>
        <div class="list">
          ${
            room.participants.length
              ? room.participants
                  .map((participant) => `<span class="tag">${escapeHtml(participant.name)}</span>`)
                  .join('')
              : '<p class="muted">Пока никто не подключился.</p>'
          }
        </div>
      </div>
    </div>
  `;
}

function renderLeaderboard(room) {
  return `
    <div class="panel">
      <div class="panel-inner">
        <div class="section-heading"><h3>Лидерборд</h3><span class="tag">${room.leaderboard.length} ${pluralRu(room.leaderboard.length, 'игрок', 'игрока', 'игроков')}</span></div>
        <div class="leaderboard">
          ${
            room.leaderboard.length
              ? room.leaderboard
                  .map(
                    (row, index) => `
                      <div class="leaderboard-row">
                        <strong>${index + 1}</strong>
                        <span>${escapeHtml(row.name)}</span>
                        <strong>${row.score}</strong>
                      </div>
                    `,
                  )
                  .join('')
              : '<p class="muted">Баллы появятся после ответов.</p>'
          }
        </div>
      </div>
    </div>
  `;
}

function renderHistory() {
  return `
    <section class="page-title">
      <div>
        <h1>История</h1>
        <p>${state.user.role === 'organizer' ? 'Проведённые комнаты и победители.' : 'Квизы, в которых вы участвовали.'}</p>
      </div>
    </section>
    <section class="list">
      ${
        state.history.length
          ? state.history.map(renderHistoryCard).join('')
          : '<div class="empty">История пока пуста.</div>'
      }
    </section>
  `;
}

function renderRecentHistory(limit) {
  const items = state.history.slice(0, limit);

  if (!items.length) {
    return '<p class="muted">История пока пуста.</p>';
  }

  return `<div class="list">${items.map(renderHistoryCard).join('')}</div>`;
}

function renderHistoryCard(item) {
  const result =
    state.user.role === 'organizer'
      ? item.winner
        ? `Победитель: ${escapeHtml(item.winner.name)} (${item.winner.score})`
        : 'Победитель не определён'
      : item.myResult
        ? `Ваш результат: ${item.myResult.score}`
        : 'Результат не найден';

  return `
    <article class="card">
      <div class="card-header">
        <div>
          <h3>${escapeHtml(item.quizTitle)}</h3>
          <p>${result}</p>
          <div class="meta">
            <span class="tag">${item.code}</span>
            <span class="tag">${statusName(item.status)}</span>
            <span class="tag">${item.participantsCount} ${pluralRu(item.participantsCount, 'участник', 'участника', 'участников')}</span>
          </div>
        </div>
      </div>
    </article>
  `;
}

function emptyQuiz() {
  return {
    title: 'Новый квиз',
    description: '',
    category: 'Общее',
    questionTimeLimit: 30,
    rules: 'Ответ доступен только во время показа вопроса. Побеждает участник с максимальным количеством баллов.',
    questions: [emptyQuestion()],
  };
}

function emptyQuestion() {
  return {
    id: tempId('question'),
    type: 'text',
    prompt: '',
    imageUrl: '',
    answerMode: 'single',
    points: 1,
    options: [emptyOption(true), emptyOption(false), emptyOption(false), emptyOption(false)],
  };
}

function emptyOption(correct) {
  return {
    id: tempId('option'),
    text: '',
    correct,
  };
}

function ensureQuestionCorrectness(question) {
  if (question.answerMode === 'single') {
    const firstCorrectIndex = Math.max(
      0,
      question.options.findIndex((option) => option.correct),
    );
    question.options.forEach((option, index) => {
      option.correct = index === firstCorrectIndex;
    });
    return;
  }

  if (!question.options.some((option) => option.correct) && question.options[0]) {
    question.options[0].correct = true;
  }
}

function updateCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach((element) => {
    const endsAt = new Date(element.dataset.countdown).getTime();
    const seconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    element.textContent = `${seconds}s`;

    const submitButton = document.querySelector('.js-answer-submit');
    if (submitButton && seconds <= 0) {
      submitButton.disabled = true;
      submitButton.textContent = 'Время вышло';
    }
  });
}

function showToast(message, type = '') {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.hidden = false;

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function pluralRu(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }

  return many;
}

function roleName(role) {
  return role === 'organizer' ? 'организатор' : 'участник';
}

function statusName(status) {
  return {
    lobby: 'ожидание',
    question: 'идёт',
    finished: 'завершён',
  }[status];
}

function tempId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const chars = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return chars[char];
  });
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}
