'use strict';
// Єдине місце з налаштуваннями «куди дивитись за оновленнями».
// Для іншого навчального закладу достатньо змінити REPO (і за потреби гілку з розкладом).
module.exports = {
  REPO: 'repaulshadow/automeet',          // GitHub-репозиторій: релізи з інсталяторами
  SCHEDULE_BRANCH: 'main',                // гілка, де лежать schedule.json та manifest.json
  get RAW_BASE() { return `https://raw.githubusercontent.com/${this.REPO}/${this.SCHEDULE_BRANCH}/`; },
  get RELEASES_PAGE() { return `https://github.com/${this.REPO}/releases`; },
  APP_CHECK_MS: 12 * 3600 * 1000,         // як часто питати GitHub про нову версію програми
};
