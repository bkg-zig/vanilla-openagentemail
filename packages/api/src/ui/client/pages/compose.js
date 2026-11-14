  /* ---- Webmail: write, reply, forward ----
     The dialog is built here instead of in the shell template. Field order is
     fixed for keyboard and screen reader use: From, To, Subject, Text, Send,
     Cancel. Sending goes through POST /ui/api/send. */
  var COMPOSE_MAX_RECIPIENTS = 50;
  var COMPOSE_ADDRESS_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

  var composeModal = null;
  var composeTitle = null;
  var composeFrom = null;
  var composeTo = null;
  var composeSubject = null;
  var composeText = null;
  var composeStatus = null;
  var composeSend = null;
  var composeCancel = null;
  /* Reply threading for the open dialog; null for a new mail or a forward. */
  var composeThread = null;
  var composeSending = false;
  /* A retry after a network failure reuses the key, so one mail is never sent twice. */
  var composeLastBody = '';
  var composeLastKey = '';

  function composeField(form, id, labelKey, control) {
    var label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = t(labelKey);
    control.id = id;
    form.append(label, control);
    return control;
  }

  function buildComposeModal() {
    if (composeModal) return;
    composeModal = document.createElement('div');
    composeModal.className = 'modal-overlay';
    composeModal.id = 'compose-modal';
    composeModal.hidden = true;

    var card = document.createElement('div');
    card.className = 'modal-card';
    card.classList.add('compose-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'compose-title');

    composeTitle = document.createElement('h2');
    composeTitle.id = 'compose-title';

    var form = document.createElement('form');
    form.id = 'compose-form';
    form.className = 'compose-form';
    form.noValidate = true;
    /* Enter in a text field must never send the mail by accident. */
    form.addEventListener('submit', function (event) {
      event.preventDefault();
    });

    composeFrom = composeField(form, 'compose-from', 'shell.html.from', document.createElement('select'));

    composeTo = document.createElement('input');
    composeTo.type = 'text';
    composeTo.setAttribute('inputmode', 'email');
    composeTo.setAttribute('autocomplete', 'off');
    composeTo.setAttribute('autocapitalize', 'off');
    composeTo.setAttribute('spellcheck', 'false');
    composeTo.setAttribute('aria-required', 'true');
    composeTo.setAttribute('aria-describedby', 'compose-to-hint');
    composeField(form, 'compose-to', 'shell.html.to', composeTo);
    var toHint = document.createElement('p');
    toHint.id = 'compose-to-hint';
    toHint.className = 'form-hint';
    toHint.textContent = t('compose.hint.recipients');
    form.append(toHint);

    composeSubject = document.createElement('input');
    composeSubject.type = 'text';
    composeSubject.maxLength = 998;
    composeSubject.setAttribute('autocomplete', 'off');
    composeField(form, 'compose-subject', 'tasks.action.subject', composeSubject);

    composeText = document.createElement('textarea');
    composeText.rows = 12;
    composeField(form, 'compose-text', 'compose.label.text', composeText);

    /* Errors and progress are announced here; success is announced globally
       because the dialog is gone by then. */
    composeStatus = document.createElement('p');
    composeStatus.id = 'compose-status';
    composeStatus.className = 'notice';
    composeStatus.setAttribute('role', 'status');
    composeStatus.setAttribute('aria-live', 'polite');

    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.classList.add('compose-actions');
    composeSend = document.createElement('button');
    composeSend.type = 'button';
    composeSend.id = 'compose-send';
    composeSend.className = 'primary';
    composeSend.textContent = t('compose.action.send');
    composeSend.addEventListener('click', submitCompose);
    composeCancel = document.createElement('button');
    composeCancel.type = 'button';
    composeCancel.id = 'compose-cancel';
    composeCancel.className = 'quiet';
    composeCancel.textContent = t('shell.html.cancel');
    composeCancel.addEventListener('click', function () {
      closeAllModals();
    });
    actions.append(composeSend, composeCancel);

    form.append(composeStatus, actions);
    card.append(composeTitle, form);
    composeModal.append(card);
    composeModal.addEventListener('keydown', trapComposeFocus);
    inboxView.append(composeModal);
  }

  /* Tab stays inside the dialog: the page behind it is not inert. */
  function trapComposeFocus(event) {
    if (event.key !== 'Tab') return;
    var stops = [composeFrom, composeTo, composeSubject, composeText, composeSend, composeCancel]
      .filter(function (node) { return !node.disabled; });
    if (stops.length === 0) return;
    var first = stops[0];
    var last = stops[stops.length - 1];
    var current = document.activeElement;
    if (event.shiftKey && (current === first || stops.indexOf(current) === -1)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (current === last || stops.indexOf(current) === -1)) {
      event.preventDefault();
      first.focus();
    }
  }

  function isComposeOpen() {
    return Boolean(composeModal) && !composeModal.hidden;
  }

  /* Called by closeAllModals (Cancel, Escape, route change, sign-out). */
  function closeComposeModal() {
    if (!composeModal) return;
    composeModal.hidden = true;
    composeThread = null;
    composeTo.value = '';
    composeSubject.value = '';
    composeText.value = '';
    composeStatus.textContent = '';
    composeStatus.classList.remove('error');
    composeTo.removeAttribute('aria-invalid');
    setComposeBusy(false);
  }

  function setComposeBusy(busy) {
    composeSending = busy;
    composeSend.disabled = busy;
    composeSend.textContent = busy ? t('compose.action.sending') : t('compose.action.send');
  }

  function setComposeStatus(message, isError) {
    composeStatus.classList.toggle('error', Boolean(isError));
    composeStatus.textContent = '';
    window.setTimeout(function () {
      composeStatus.textContent = message;
    }, 0);
  }

  function fillComposeFrom(preferred) {
    composeFrom.replaceChildren();
    var wanted = String(preferred || '').toLowerCase();
    state.identities.forEach(function (identity) {
      var option = document.createElement('option');
      option.value = identity.address;
      option.textContent = identity.name
        ? identity.name + ' <' + identity.address + '>'
        : identity.address;
      if (identity.address.toLowerCase() === wanted) option.selected = true;
      composeFrom.append(option);
    });
    var empty = composeFrom.options.length === 0;
    composeFrom.disabled = empty;
    composeSend.disabled = empty;
    return !empty;
  }

  /* Takes the bare address out of a display form such as: Name <a@b.example>. */
  function composeExtractAddress(value) {
    var text = String(value || '');
    var open = text.lastIndexOf('<');
    var close = text.lastIndexOf('>');
    if (open !== -1 && close > open) return text.slice(open + 1, close).trim();
    return text.split(',')[0].trim();
  }

  function composePrefixSubject(prefix, subject) {
    var text = String(subject || '').trim();
    if (text.toLowerCase().indexOf(prefix.toLowerCase()) === 0) return text;
    return prefix + text;
  }

  function composeQuote(detail) {
    var intro = tFormat('compose.quote.onDateWrote', {
      date: formatDate(detail.date),
      from: detail.from || t('inbox.action.unknownSender')
    });
    var quoted = String(detail.text || '').replace(/\r\n?/g, '\n').split('\n').map(function (line) {
      return '> ' + line;
    }).join('\n');
    return '\n\n' + intro + '\n' + quoted + '\n';
  }

  function composeForwardBody(detail) {
    var lines = [
      t('compose.forward.marker'),
      t('shell.html.from') + ': ' + (detail.from || ''),
      t('shell.html.date') + ': ' + formatDate(detail.date),
      t('tasks.action.subject') + ': ' + (detail.subject || ''),
      t('shell.html.to') + ': ' + (detail.to || ''),
      '',
      String(detail.text || '').replace(/\r\n?/g, '\n')
    ];
    return '\n\n' + lines.join('\n') + '\n';
  }

  /* mode is new, reply or forward. detail is the open message for the last two. */
  function openCompose(mode, detail) {
    buildComposeModal();
    beginModal();
    composeThread = null;
    composeLastBody = '';
    composeLastKey = '';
    setComposeBusy(false);
    composeStatus.textContent = '';
    composeStatus.classList.remove('error');
    composeTo.removeAttribute('aria-invalid');

    var titleKey = 'compose.title.newMessage';
    var to = '';
    var subject = '';
    var text = '';
    if (mode === 'reply' && detail) {
      titleKey = 'compose.title.reply';
      to = composeExtractAddress(detail.from);
      subject = composePrefixSubject('Re: ', detail.subject);
      text = composeQuote(detail);
      if (detail.messageId) {
        var chain = Array.isArray(detail.references) ? detail.references.slice() : [];
        if (chain.indexOf(detail.messageId) === -1) chain.push(detail.messageId);
        /* The server accepts at most 50 references; keep the newest. */
        composeThread = { inReplyTo: detail.messageId, references: chain.slice(-50) };
      }
    } else if (mode === 'forward' && detail) {
      titleKey = 'compose.title.forward';
      subject = composePrefixSubject('Fwd: ', detail.subject);
      text = composeForwardBody(detail);
    }
    composeTitle.textContent = t(titleKey);
    composeTo.value = to;
    composeSubject.value = subject;
    composeText.value = text;
    var hasSender = fillComposeFrom(state.activeAddress);
    composeModal.hidden = false;
    if (!hasSender) setComposeStatus(t('compose.error.noSender'), true);
    composeTo.focus();
    /* Reply and forward: the caret starts above the quoted text. */
    try { composeText.setSelectionRange(0, 0); } catch (_err) { /* optional */ }
    composeText.scrollTop = 0;
  }

  function parseComposeRecipients(raw) {
    var parts = String(raw || '').split(/[\s,;]+/).filter(function (part) { return part; });
    var seen = {};
    var list = [];
    var invalid = [];
    parts.forEach(function (part) {
      var address = composeExtractAddress(part);
      if (!COMPOSE_ADDRESS_RE.test(address)) {
        invalid.push(part);
        return;
      }
      var key = address.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      list.push(address);
    });
    return { list: list, invalid: invalid };
  }

  function composeErrorMessage(error) {
    var body = error && error.body ? error.body : null;
    var code = body && typeof body.error === 'string' ? body.error : '';
    if (error.status === 429) {
      return tFormat('compose.error.rateLimited', {
        seconds: body && body.retryAfterSec != null ? body.retryAfterSec : 60
      });
    }
    if (error.status === 413) return t('compose.error.tooLarge');
    if (error.status === 403) return t('compose.error.forbidden');
    if (error.status === 400 || error.status === 422) return t('compose.error.invalid');
    if (error.status === 409) return t('compose.error.inFlight');
    if (error.status === 502 || code === 'smtp_error') return t('compose.error.mailServer');
    if (!error.status) return t('compose.error.network');
    return t('compose.error.generic');
  }

  function composeIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return String(Date.now()) + '-' + String(Math.random()).slice(2);
  }

  async function submitCompose() {
    if (composeSending || !isComposeOpen()) return;
    var recipients = parseComposeRecipients(composeTo.value);
    var recipientError = '';
    if (recipients.invalid.length > 0) {
      recipientError = tFormat('compose.error.invalidRecipient', { address: recipients.invalid[0] });
    } else if (recipients.list.length === 0) {
      recipientError = t('compose.error.noRecipient');
    } else if (recipients.list.length > COMPOSE_MAX_RECIPIENTS) {
      recipientError = tFormat('compose.error.tooManyRecipients', { max: COMPOSE_MAX_RECIPIENTS });
    }
    if (recipientError) {
      composeTo.setAttribute('aria-invalid', 'true');
      setComposeStatus(recipientError, true);
      composeTo.focus();
      return;
    }
    composeTo.removeAttribute('aria-invalid');
    var from = composeFrom.value;
    if (!from) {
      setComposeStatus(t('compose.error.noSender'), true);
      composeFrom.focus();
      return;
    }

    var payload = {
      from: from,
      to: recipients.list,
      subject: composeSubject.value,
      text: composeText.value
    };
    if (composeThread) {
      payload.inReplyTo = composeThread.inReplyTo;
      payload.references = composeThread.references;
    }
    var body = JSON.stringify(payload);
    if (body !== composeLastBody || !composeLastKey) {
      composeLastBody = body;
      composeLastKey = composeIdempotencyKey();
    }

    var openedGen = modalGeneration;
    setComposeBusy(true);
    setComposeStatus(t('compose.action.sending'), false);
    try {
      await sendMessage(body, composeLastKey);
    } catch (error) {
      if (error.message === 'session_expired') return;
      /* An answered request settles the key; only a network failure keeps it for a retry. */
      if (error.status) {
        composeLastBody = '';
        composeLastKey = '';
      }
      var message = composeErrorMessage(error);
      if (openedGen === modalGeneration && isComposeOpen()) {
        setComposeBusy(false);
        setComposeStatus(message, true);
        composeSend.focus();
      } else {
        /* The dialog was closed while sending: still tell the user it failed. */
        announce(message);
      }
      return;
    }
    composeLastBody = '';
    composeLastKey = '';
    /* Close first so focus is back on the button that opened the dialog. */
    if (openedGen === modalGeneration && isComposeOpen()) closeAllModals();
    if (state.activeFolder === 'sent' && state.activeAddress.toLowerCase() === from.toLowerCase()) {
      await refreshMessages();
    }
    announce(tFormat('compose.announce.sent', { to: recipients.list.join(', ') }));
  }

  /* Reply and Forward buttons for the message detail header. */
  function appendComposeActions(header, detail) {
    var actions = document.createElement('div');
    actions.className = 'detail-actions';
    var reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'quiet';
    reply.textContent = t('compose.action.reply');
    reply.addEventListener('click', function () {
      openCompose('reply', detail);
    });
    var forward = document.createElement('button');
    forward.type = 'button';
    forward.className = 'quiet';
    forward.textContent = t('compose.action.forward');
    forward.addEventListener('click', function () {
      openCompose('forward', detail);
    });
    actions.append(reply, forward);
    header.append(actions);
  }

