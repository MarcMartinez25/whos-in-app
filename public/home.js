const editor = createScheduleEditor($('schedule-editor'), []);

const showError = (err) => {
  $('status').textContent = err.status ? err.message : "Can't reach the server. Try again in a sec.";
};

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('create-button');
  button.disabled = true;
  $('status').textContent = '';
  try {
    const { id } = await api('POST', '/api/teams', {
      team: $('team-input').value,
      email: $('email-input').value,
      schedule: editor.getSchedule(),
    });
    location.href = `/t/${id}`;
  } catch (err) {
    showError(err);
    button.disabled = false;
  }
});

$('forgot-open').addEventListener('click', () => {
  $('forgot-window').hidden = false;
  $('forgot-window').scrollIntoView();
  $('forgot-email').focus();
});

$('forgot-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('status').textContent = '';
  try {
    await api('POST', '/api/recover', { email: $('forgot-email').value });
    $('forgot-form').hidden = true;
    $('forgot-done').hidden = false;
  } catch (err) {
    showError(err);
  }
});
