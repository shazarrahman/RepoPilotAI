document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const applyTheme = (theme) => {
    const dark = theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('theme-toggle').setAttribute('aria-checked', String(dark));
    $('theme-toggle').querySelector('.theme-label').textContent = dark ? 'Dark' : 'Light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#151b18' : '#f4f5f1';
    try {
      localStorage.setItem('repopilot-theme', dark ? 'dark' : 'light');
    } catch {
      // Theme switching still works when browser storage is unavailable.
    }
  };
  let savedTheme = 'dark';
  try {
    savedTheme = localStorage.getItem('repopilot-theme') || savedTheme;
  } catch {
    // The default theme remains available without browser storage.
  }
  applyTheme(savedTheme);
  $('theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  let token = sessionStorage.getItem('repopilot-session-token') || '';
  let workspaceId = '';
  let workspaces = [];
  let conversationId = '';
  let sourceReady = false;
  let chatStarted = false;

  const setNotice = (message, kind = '') => {
    const notice = $('notice');
    notice.textContent = message;
    notice.className = `notice${kind ? ` ${kind}` : ''}`;
    notice.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    if (kind === 'error') {
      notice.focus();
      notice.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  const validateCredentials = () => {
    const email = $('email');
    const password = $('password');
    const valid = email.validity.valid && password.value.length >= 8 && password.value.length <= 128;
    $('email-error').textContent = email.validity.valid ? '' : 'Enter a valid email address.';
    $('password-error').textContent = password.value.length < 8 ? 'Use at least 8 characters.' : password.value.length > 128 ? 'Use no more than 128 characters.' : '';
    email.setAttribute('aria-invalid', String(!email.validity.valid));
    password.setAttribute('aria-invalid', String(password.value.length < 8 || password.value.length > 128));
    if (!valid) setNotice('Check the highlighted account fields and try again.', 'error');
    return valid;
  };

  const updateSteps = () => {
    const current = !token ? 'account' : !workspaceId ? 'workspace' : !sourceReady || !chatStarted ? 'source' : 'question';
    document.querySelectorAll('.step').forEach((step) => {
      const isCurrent = step.dataset.step === current;
      const isComplete = step.dataset.step === 'account' ? Boolean(token)
        : step.dataset.step === 'workspace' ? Boolean(workspaceId)
          : step.dataset.step === 'source' ? sourceReady
            : Boolean(sourceReady && chatStarted);
      const marker = step.querySelector('.step-mark');
      step.classList.toggle('active', isCurrent);
      step.classList.toggle('complete', isComplete && !isCurrent);
      if (isCurrent) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
      marker.textContent = isComplete && !isCurrent ? '✓' : marker.dataset.stepNumber;
    });
    $('create').disabled = !token;
    $('upload').disabled = !workspaceId;
    $('import-repo').disabled = !workspaceId;
    $('ask').disabled = !sourceReady;
    $('continue-to-chat').disabled = !sourceReady;
    document.querySelectorAll('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== current;
    });
  };

  const api = async (path, options = {}) => {
    let response;
    try {
      response = await fetch(path, { ...options, headers: { Authorization: token ? `Bearer ${token}` : '', ...options.headers } });
    } catch {
      throw new Error('Cannot reach RepoPilotAI. Check that the local server is running, then try again.');
    }
    const data = await response.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : 'The request could not be completed.';
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return data;
  };

  const refreshUsage = async () => {
    try {
      const usage = await api('/v1/usage');
      $('usage-status').textContent = `AI budget: ${usage.remainingTokens.toLocaleString()} estimated tokens left today`;
    } catch {
      $('usage-status').textContent = 'Daily AI budget enforced';
    }
  };

  const storageKey = (key) => `repopilot-${key}:${workspaceId}`;

  const renderSources = (documents) => {
    const list = $('sources-list');
    list.replaceChildren();
    for (const source of documents) {
      const row = document.createElement('div');
      row.className = 'source-row';
      const name = document.createElement('span');
      name.className = 'source-name';
      name.textContent = source.filename;
      const remove = document.createElement('button');
      remove.className = 'source-remove';
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${source.filename}`);
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Remove ${source.filename}? Saved chats citing this source will also be deleted.`)) return;
        remove.disabled = true;
        try {
          const result = await api(`/v1/workspaces/${workspaceId}/documents/${source.id}`, { method: 'DELETE' });
          await loadWorkspace(workspaceId, { restoreChat: chatStarted });
          setNotice(`Source removed. ${result.conversationsDeleted || 0} related saved chats deleted.`, 'success');
        } catch (error) {
          remove.disabled = false;
          setNotice(error.message || 'Could not remove this source.', 'error');
        }
      });
      row.append(name, remove);
      list.append(row);
    }
    if (!documents.length) {
      const empty = document.createElement('p');
      empty.className = 'field-note';
      empty.textContent = 'No indexed sources yet.';
      list.append(empty);
    }
  };

  const renderMessages = (messages) => {
    const history = $('conversation-history');
    history.replaceChildren();
    for (const message of messages) {
      const entry = document.createElement('article');
      entry.className = 'chat-message';
      entry.dataset.role = message.role;
      const role = document.createElement('p');
      role.className = 'chat-role';
      role.textContent = message.role === 'assistant' ? 'RepoPilotAI' : 'You';
      const content = document.createElement('p');
      content.className = 'chat-content';
      content.textContent = message.content;
      entry.append(role, content);
      for (const citation of message.citations || []) {
        const citationLabel = document.createElement('span');
        citationLabel.className = 'citation';
        citationLabel.textContent = `${citation.filename} · chunk ${citation.chunkIndex}`;
        entry.append(citationLabel);
      }
      history.append(entry);
    }
    history.scrollTop = history.scrollHeight;
  };

  const loadConversation = async (id) => {
    conversationId = id || '';
    $('delete-conversation').disabled = !conversationId;
    sessionStorage.setItem(storageKey('conversation'), conversationId);
    if (!conversationId) {
      renderMessages([]);
      $('answer').textContent = 'Start a conversation about your workspace sources.';
      $('citations').replaceChildren();
      return;
    }
    const detail = await api(`/v1/workspaces/${workspaceId}/conversations/${conversationId}`);
    renderMessages(detail.messages);
    const lastAnswer = [...detail.messages].reverse().find((message) => message.role === 'assistant');
    $('answer').textContent = lastAnswer?.content || 'This conversation has no answers yet.';
    $('citations').replaceChildren();
    for (const citation of lastAnswer?.citations || []) {
      const item = document.createElement('span');
      item.className = 'citation';
      item.textContent = `${citation.filename} · chunk ${citation.chunkIndex}`;
      $('citations').append(item);
    }
  };

  const refreshConversations = async (preferredId = '') => {
    const picker = $('conversation-picker');
    const conversations = await api(`/v1/workspaces/${workspaceId}/conversations`);
    picker.replaceChildren(new Option('New conversation', ''));
    for (const conversation of conversations) picker.add(new Option(conversation.title, conversation.id));
    const savedId = preferredId || sessionStorage.getItem(storageKey('conversation')) || conversations[0]?.id || '';
    const selectedId = conversations.some((item) => item.id === savedId) ? savedId : '';
    picker.value = selectedId;
    await loadConversation(selectedId);
    return conversations;
  };

  const populateWorkspacePicker = (selectedId = '') => {
    const menu = $('workspace-menu');
    const options = $('workspace-options');
    options.replaceChildren();
    const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedId);
    $('workspace-current').textContent = selectedWorkspace?.name || (workspaces.length ? 'New workspace' : 'Choose a workspace');
    $('workspace-count').textContent = String(workspaces.length);
    for (const workspace of workspaces) {
      const option = document.createElement('button');
      option.className = 'workspace-option';
      option.type = 'button';
      option.dataset.workspaceId = workspace.id;
      option.setAttribute('aria-current', workspace.id === selectedId ? 'true' : 'false');
      const marker = document.createElement('span');
      marker.className = 'workspace-option-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = workspace.id === selectedId ? '✓' : '';
      const name = document.createElement('span');
      name.className = 'workspace-option-name';
      name.textContent = workspace.name;
      const state = document.createElement('span');
      state.className = 'workspace-option-state';
      state.textContent = workspace.id === selectedId ? 'ACTIVE' : '';
      option.append(marker, name, state);
      options.append(option);
    }
    menu.hidden = !token;
    $('new-workspace').hidden = !token;
    $('delete-workspace').hidden = !token || !selectedId;
  };

  const loadWorkspace = async (id, { restoreChat = false } = {}) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error('Choose a workspace to continue.');
    workspaceId = id;
    sessionStorage.setItem('repopilot-active-workspace', id);
    populateWorkspacePicker(id);
    $('workspace-status').textContent = `Active workspace: ${workspace.name}`;
    const documents = await api(`/v1/workspaces/${id}/documents`);
    sourceReady = documents.length > 0;
    $('source-status').textContent = `${documents.length} indexed ${documents.length === 1 ? 'source' : 'sources'}`;
    renderSources(documents);
    const conversations = await refreshConversations();
    chatStarted = sourceReady && (restoreChat || sessionStorage.getItem(storageKey('chat-started')) === 'true' || conversations.length > 0);
    updateSteps();
    return workspace;
  };

  const restoreSession = async () => {
    if (!token) return;
    try {
      workspaces = await api('/v1/workspaces');
      $('session').textContent = $('email').value || 'Signed in';
      $('session').classList.add('signed-in');
      $('sign-out').hidden = false;
      await refreshUsage();
      populateWorkspacePicker();
      if (!workspaces.length) {
        setNotice('Session restored. Create a workspace to continue.', 'success');
        return;
      }
      const activeId = sessionStorage.getItem('repopilot-active-workspace');
      await loadWorkspace(workspaces.some((item) => item.id === activeId) ? activeId : workspaces[0].id, { restoreChat: true });
      setNotice('Session, workspace, and saved conversations restored in this tab.', 'success');
    } catch (error) {
      if (error.status === 401) {
        token = '';
        sessionStorage.removeItem('repopilot-session-token');
        sessionStorage.removeItem('repopilot-user-email');
        sessionStorage.removeItem('repopilot-active-workspace');
        $('sign-out').hidden = true;
        $('session').textContent = 'Not signed in';
        $('session').classList.remove('signed-in');
        updateSteps();
        setNotice('Your session expired. Sign in again to continue.', 'error');
      } else {
        setNotice(error.message || 'Could not restore your workspace. Your sign-in is retained; retry when the service is available.', 'error');
      }
    }
  };

  const run = async (button, action) => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Something went wrong. Please try again.', 'error');
      if (button.id === 'ask') $('answer').textContent = 'No answer was generated. Resolve the error above, then try again.';
    } finally {
      button.removeAttribute('aria-busy');
      updateSteps();
      if (button.id === 'register' || button.id === 'login') button.disabled = false;
    }
  };

  $('register').addEventListener('click', (event) => run(event.currentTarget, async () => {
    if (!validateCredentials()) return;
    await api('/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) });
    setNotice('Account created. Sign in with your new credentials.', 'success');
  }));

  $('login').addEventListener('click', (event) => run(event.currentTarget, async () => {
    if (!validateCredentials()) return;
    const data = await api('/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }) });
    token = data.token;
    sessionStorage.setItem('repopilot-session-token', token);
    sessionStorage.setItem('repopilot-user-email', data.user.email);
    $('session').textContent = data.user.email;
    $('session').classList.add('signed-in');
    $('sign-out').hidden = false;
    await refreshUsage();
    workspaces = await api('/v1/workspaces');
    populateWorkspacePicker();
    if (workspaces.length) {
      const savedId = sessionStorage.getItem('repopilot-active-workspace');
      await loadWorkspace(workspaces.some((item) => item.id === savedId) ? savedId : workspaces[0].id, { restoreChat: true });
      setNotice('Workspace restored. Add sources or continue to a saved conversation.', 'success');
    } else {
      workspaceId = '';
      updateSteps();
      setNotice('You are signed in. Create a workspace to continue.', 'success');
    }
  }));

  $('create').addEventListener('click', (event) => run(event.currentTarget, async () => {
    const data = await api('/v1/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('workspace').value.trim() }) });
    workspaces = [data, ...workspaces];
    populateWorkspacePicker(data.id);
    sourceReady = false;
    chatStarted = false;
    conversationId = '';
    await loadWorkspace(data.id);
    setNotice(`Workspace "${data.name}" created. Add its first source.`, 'success');
  }));

  $('upload').addEventListener('click', (event) => run(event.currentTarget, async () => {
    const file = $('file').files[0];
    if (!file) throw new Error('Choose a .txt or .md file first.');
    if (!/\.(txt|md)$/i.test(file.name)) throw new Error('Unsupported file type. Choose a .txt or .md file.');
    if (file.size > 2_000_000) throw new Error('This file is larger than the 2 MB limit. Choose a smaller file.');
    const form = new FormData();
    form.append('file', file);
    const data = await api(`/v1/workspaces/${workspaceId}/documents`, { method: 'POST', body: form });
    await loadWorkspace(workspaceId);
    await refreshUsage();
    setNotice(`${data.document.filename} indexed into ${data.chunksCreated} searchable chunks. Add another source or continue to chat.`, 'success');
  }));

  $('import-repo').addEventListener('click', (event) => run(event.currentTarget, async () => {
    const repositoryUrl = $('github-repo').value.trim();
    if (!repositoryUrl) throw new Error('Enter a GitHub repository URL first.');
    const accessToken = $('github-token').value.trim();
    $('github-token').value = '';
    $('github-error').textContent = '';
    const data = await api(`/v1/workspaces/${workspaceId}/repositories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryUrl, ...(accessToken ? { accessToken } : {}) }),
    });
    await loadWorkspace(workspaceId);
    await refreshUsage();
    setNotice(`github.com/${data.repository} indexed from ${data.branch}: ${data.filesIndexed} files and ${data.chunksCreated} chunks${data.skippedFiles ? `; ${data.skippedFiles} skipped by limits` : ''}. Add another source or continue.`, 'success');
  }));

  $('continue-to-chat').addEventListener('click', () => {
    if (!sourceReady) return;
    chatStarted = true;
    sessionStorage.setItem(storageKey('chat-started'), 'true');
    updateSteps();
    setNotice('Your sources are ready. Ask a question.', 'success');
  });

  $('manage-sources').addEventListener('click', () => {
    chatStarted = false;
    sessionStorage.removeItem(storageKey('chat-started'));
    updateSteps();
    setNotice('Add another document or repository, then continue to chat.', 'success');
  });

  $('workspace-options').addEventListener('click', async (event) => {
    const option = event.target.closest('[data-workspace-id]');
    if (!option || option.dataset.workspaceId === workspaceId) {
      $('workspace-menu').open = false;
      return;
    }
    try {
      await loadWorkspace(option.dataset.workspaceId, { restoreChat: true });
      $('workspace-menu').open = false;
      setNotice(`Switched to ${workspaces.find((item) => item.id === workspaceId).name}.`, 'success');
    } catch (error) {
      setNotice(error.message || 'Could not switch workspaces.', 'error');
    }
  });

  document.addEventListener('click', (event) => {
    if (!$('workspace-menu').contains(event.target)) $('workspace-menu').open = false;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('workspace-menu').open) {
      $('workspace-menu').open = false;
      $('workspace-menu').querySelector('summary').focus();
    }
  });

  $('new-workspace').addEventListener('click', () => {
    $('workspace-menu').open = false;
    workspaceId = '';
    sourceReady = false;
    chatStarted = false;
    conversationId = '';
    $('workspace-status').textContent = '';
    $('source-status').textContent = '';
    $('sources-list').replaceChildren();
    populateWorkspacePicker();
    updateSteps();
    setNotice('Create a new workspace. Existing workspaces and conversations remain saved.', 'success');
  });

  $('delete-workspace').addEventListener('click', async () => {
    const selected = workspaces.find((item) => item.id === workspaceId);
    if (!selected || !window.confirm(`Delete workspace "${selected.name}" and all of its sources, chunks, and saved conversations? This cannot be undone.`)) return;
    try {
      await api(`/v1/workspaces/${workspaceId}`, { method: 'DELETE' });
      workspaces = workspaces.filter((item) => item.id !== workspaceId);
      sessionStorage.removeItem(`repopilot-conversation:${workspaceId}`);
      sessionStorage.removeItem(`repopilot-chat-started:${workspaceId}`);
      workspaceId = '';
      sourceReady = false;
      chatStarted = false;
      conversationId = '';
      populateWorkspacePicker();
      if (workspaces.length) await loadWorkspace(workspaces[0].id);
      else updateSteps();
      $('workspace-menu').open = false;
      setNotice('Workspace and its source/chat data deleted.', 'success');
    } catch (error) {
      setNotice(error.message || 'Could not delete workspace.', 'error');
    }
  });

  $('conversation-picker').addEventListener('change', (event) => run(event.currentTarget, async () => {
    await loadConversation(event.currentTarget.value);
    setNotice(event.currentTarget.value ? 'Saved conversation restored.' : 'New conversation ready.', 'success');
  }));

  $('new-conversation').addEventListener('click', () => {
    $('conversation-picker').value = '';
    void loadConversation('');
    setNotice('New conversation started. Previous chats remain saved in this workspace.', 'success');
  });

  $('delete-conversation').addEventListener('click', async () => {
    if (!conversationId || !window.confirm('Delete this saved conversation and its messages?')) return;
    try {
      await api(`/v1/workspaces/${workspaceId}/conversations/${conversationId}`, { method: 'DELETE' });
      conversationId = '';
      await refreshConversations('');
      setNotice('Conversation deleted.', 'success');
    } catch (error) {
      setNotice(error.message || 'Could not delete conversation.', 'error');
    }
  });

  $('sign-out').addEventListener('click', () => {
    token = '';
    workspaceId = '';
    sourceReady = false;
    chatStarted = false;
    sessionStorage.removeItem('repopilot-session-token');
    sessionStorage.removeItem('repopilot-user-email');
    sessionStorage.removeItem('repopilot-chat-started');
    $('session').textContent = 'Not signed in';
    $('session').classList.remove('signed-in');
    $('sign-out').hidden = true;
    $('workspace-menu').hidden = true;
    $('new-workspace').hidden = true;
    $('delete-workspace').hidden = true;
    $('workspace-options').replaceChildren();
    workspaces = [];
    conversationId = '';
    updateSteps();
    setNotice('You have signed out.', 'success');
  });

  $('question-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run($('ask'), async () => {
      const question = $('question').value.trim();
      if (question.length < 3) throw new Error('Enter a question with at least 3 characters.');
      $('answer').textContent = 'Searching your source…';
      $('citations').replaceChildren();
      const data = await api(`/v1/workspaces/${workspaceId}/questions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, ...(conversationId ? { conversationId } : {}) }) });
      conversationId = data.conversationId;
      sessionStorage.setItem(storageKey('conversation'), conversationId);
      $('answer').textContent = data.answer;
      await refreshUsage();
      for (const citation of data.citations) {
        const item = document.createElement('span');
        item.className = 'citation';
        item.textContent = `${citation.filename} · chunk ${citation.chunkIndex}`;
        $('citations').append(item);
      }
      const conversations = await refreshConversations(conversationId);
      $('conversation-picker').value = conversationId;
      chatStarted = true;
      sessionStorage.setItem(storageKey('chat-started'), 'true');
      updateSteps();
      setNotice('Answer generated from your workspace sources.', 'success');
    });
  });

  $('email').addEventListener('input', () => $('email-error').textContent = '');
  $('password').addEventListener('input', () => $('password-error').textContent = '');
  updateSteps();
  if (token) {
    $('email').value = sessionStorage.getItem('repopilot-user-email') || '';
    restoreSession();
  }
});