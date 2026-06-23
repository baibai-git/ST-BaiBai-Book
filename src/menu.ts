import { openBook } from '@/state/ui';

const MENU_ITEM_ID = 'bbs-menu-item';

/**
 * 往 ST 的 #extensionsMenu(魔杖菜单)末尾注入"柏宝书"入口。
 * 菜单是懒加载的,用轮询等它出现;注入一次即可。
 */
export function injectMenuButton() {
  const tryInject = () => {
    const $menu = $('#extensionsMenu');
    if ($menu.length === 0) return false;
    if ($(`#${MENU_ITEM_ID}`).length > 0) return true;

    const $item = $(`
      <div class="extension_container interactable" tabindex="0">
        <a id="${MENU_ITEM_ID}" class="list-group-item" href="#" title="柏宝书">
          <i class="fa-solid fa-book-bookmark"></i>
          <span>柏宝书</span>
        </a>
      </div>
    `);

    $item.on('click', (e: { preventDefault: () => void }) => {
      e.preventDefault();
      openBook();
      // 点击后收起魔杖菜单,贴合原生行为
      $('#extensionsMenu').hide();
    });

    $menu.append($item);
    return true;
  };

  if (tryInject()) return;
  const timer = setInterval(() => {
    if (tryInject()) clearInterval(timer);
  }, 500);
}
