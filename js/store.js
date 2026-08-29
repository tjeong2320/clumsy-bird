(function () {
    'use strict';

    var ACCOUNT_KEY = 'cb_accountId';
    var ENT_KEY = 'cb_entitlements';
    var MAX_PURCHASES = 4;
    var BASE_HEARTS = 1;

    function getAccountId() {
        try {
            var id = localStorage.getItem(ACCOUNT_KEY);
            if (!id) {
                id = 'cb_' + Math.random().toString(36).slice(2, 10)
                          + Date.now().toString(36);
                localStorage.setItem(ACCOUNT_KEY, id);
            }
            return id;
        } catch (e) {
            return 'cb_anon';
        }
    }

    function loadCachedEntitlements() {
        try {
            return JSON.parse(localStorage.getItem(ENT_KEY)) || { heartsPurchased: 0 };
        } catch (e) {
            return { heartsPurchased: 0 };
        }
    }

    function saveCachedEntitlements(data) {
        try { localStorage.setItem(ENT_KEY, JSON.stringify(data)); } catch (e) {}
    }

    function refreshEntitlements(cb) {
        var accountId = getAccountId();
        fetch('/api/entitlements?accountId=' + encodeURIComponent(accountId))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var ent = { heartsPurchased: data.heartsPurchased || 0 };
                saveCachedEntitlements(ent);
                if (cb) cb(ent);
                window.dispatchEvent(new CustomEvent('cb:entitlements', { detail: ent }));
                // Also tell the bird to re-resolve max hearts so the new value
                // takes effect even mid-run (HUD only listens to this event).
                if (window.game && window.game.data && window.game.data.bird
                        && typeof window.game.data.bird.resetLives === 'function') {
                    window.game.data.bird.resetLives();
                }
            })
            .catch(function () { if (cb) cb(loadCachedEntitlements()); });
    }

    function totalHearts(ent) {
        return Math.min(BASE_HEARTS + (ent.heartsPurchased || 0), BASE_HEARTS + MAX_PURCHASES);
    }

    function ensureStyles() {
        if (document.getElementById('cb-shop-styles')) return;
        var css =
            '.cb-overlay { position: fixed; left: 0; top: 0; right: 0; bottom: 0;' +
            ' background: rgba(0,0,0,0.55); display: flex; align-items: center;' +
            ' justify-content: center; z-index: 9999; font-family: Arial, sans-serif; }' +
            '.cb-modal { background: #fff; color: #222; border-radius: 10px;' +
            ' padding: 22px; width: 320px; max-width: 90vw; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }' +
            '.cb-modal h2 { margin: 0 0 8px; font-size: 20px; color: #0066aa; }' +
            '.cb-modal p  { margin: 6px 0; font-size: 14px; line-height: 1.4; }' +
            '.cb-product { display: flex; gap: 10px; align-items: center;' +
            ' background: #f3f7fa; border-radius: 6px; padding: 10px; margin: 12px 0; }' +
            '.cb-product img { width: 64px; height: 64px; }' +
            '.cb-buy { display: block; width: 100%; padding: 10px; background: #ffdf00;' +
            ' color: #000; border: 0; border-radius: 6px; font-weight: bold; cursor: pointer; }' +
            '.cb-buy:hover { background: #ffe94d; }' +
            '.cb-buy:disabled { background: #aaa; cursor: not-allowed; }' +
            '.cb-cancel { display: block; width: 100%; margin-top: 10px; padding: 8px;' +
            ' background: transparent; color: #0066aa; border: 1px solid #0066aa;' +
            ' border-radius: 6px; cursor: pointer; }' +
            '.cb-cancel:hover { background: #eef6ff; }' +
            '.cb-close { display: block; margin: 10px auto 0; padding: 6px 14px;' +
            ' background: transparent; color: #0066aa; border: 0; cursor: pointer; }' +
            '.cb-close:hover { text-decoration: underline; }' +
            '.cb-status { font-size: 13px; color: #555; margin-top: 8px; min-height: 1em; }' +
            '.cb-error { font-size: 12px; color: #c33; margin-top: 8px; }' +
            '.cb-spinner { display: inline-block; width: 14px; height: 14px;' +
            ' border: 2px solid #ccc; border-top-color: #0066aa; border-radius: 50%;' +
            ' animation: cb-spin 0.8s linear infinite; vertical-align: -2px; margin-right: 6px; }' +
            '@keyframes cb-spin { to { transform: rotate(360deg); } }';
        var s = document.createElement('style');
        s.id = 'cb-shop-styles';
        s.appendChild(document.createTextNode(css));
        document.head.appendChild(s);
    }

    // Modal state. We keep one instance; opening replaces it.
    var modalEl = null;
    var pollTimer = null;
    var pollDeadline = null;
    var currentCheckoutId = null;
    var neonTab = null;

    function closeModal() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        pollDeadline = null;
        currentCheckoutId = null;
        // Best-effort: close the Neon tab if it's still open and we opened it.
        if (neonTab && !neonTab.closed) {
            try { neonTab.close(); } catch (e) {}
        }
        neonTab = null;
        if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
        modalEl = null;
    }

    function renderBuyState() {
        var ent = loadCachedEntitlements();
        var owned = ent.heartsPurchased || 0;
        var total = totalHearts(ent);
        var maxed = owned >= MAX_PURCHASES;

        // Heart Box: $3.99 base, -$1.00 per heart the player already bought.
        // Matches the server's priceOffset formula in getPriceFromNeon().
        // Floor at $0.99 so we never show $0.00 or negative.
        var HEART_BOX_BASE = 3.99;
        var heartBoxPrice = Math.max(0.99, HEART_BOX_BASE - owned);

        modalEl.innerHTML =
            '<div class="cb-modal">' +
                '<h2>Clumsy Bird NEON Shop</h2>' +
                '<p>Buy an extra heart. You currently have <strong>' + total + '</strong> ' +
                    'heart' + (total === 1 ? '' : 's') + ' ' +
                    '(1 base + ' + owned + ' purchased).</p>' +
                '<div class="cb-product">' +
                    '<img src="data/img/heart.png" alt="" />' +
                    '<div>' +
                        '<div><strong>Extra Heart</strong></div>' +
                        '<div>$0.99 USD</div>' +
                    '</div>' +
                '</div>' +
                '<button class="cb-buy" data-sku="offer_extra_heart_sku" id="cb-buy-extra_heart"' +
                    (maxed ? ' disabled' : '') + '>' +
                    (maxed ? 'Max hearts reached' : 'Buy Extra Heart \u2014 $0.99') +
                '</button>' +
                '<div class="cb-product">' +
                    '<img src="data/img/heart_box.png" alt="" />' +
                    '<div>' +
                        '<div><strong>Heart Box</strong></div>' +
                        (owned > 0 && heartBoxPrice < HEART_BOX_BASE && owned !== 4
                            ? '<div><s>$3.99 USD</s> &rarr; <strong>$' +
                                heartBoxPrice.toFixed(2) + ' USD</strong> ' +
                                '<span style="font-size:11px;color:#080">(-$' +
                                (HEART_BOX_BASE - heartBoxPrice).toFixed(2) + ' because you own ' +
                                owned + ' heart' + (owned === 1 ? '' : 's') + ')</span></div>'
                            : '<div>$3.99 USD</div>') +
                    '</div>' +
                '</div>' +
                '<button class="cb-buy" data-sku="offer_heart_box_sku" id="cb-buy-heart_box"' +
                    (maxed ? ' disabled' : '') + '>' +
                    (maxed ? 'Max hearts reached' : 'Buy Heart Box \u2014 $' + heartBoxPrice.toFixed(2)) +
                '</button>' +
                '<div class="cb-error" id="cb-error"></div>' +
                '<button class="cb-close" id="cb-close-btn">Close</button>' +
            '</div>';

        document.getElementById('cb-close-btn').addEventListener('click', closeModal);
        // Each buy button carries its sku in a data-attribute so the click
        // handler knows which item to charge.
        var buyBtns = modalEl.querySelectorAll('.cb-buy[data-sku]');
        for (var i = 0; i < buyBtns.length; i++) {
            buyBtns[i].addEventListener('click', onBuyClick);
        }
    }

    function renderWaitState() {
        modalEl.innerHTML =
            '<div class="cb-modal">' +
                '<h2>Waiting for payment...</h2>' +
                '<p><span class="cb-spinner"></span>Complete your purchase in the new tab.</p>' +
                '<p class="cb-status" id="cb-status">Polling for confirmation...</p>' +
                '<button class="cb-cancel" id="cb-cancel-btn">Cancel</button>' +
            '</div>';
        document.getElementById('cb-cancel-btn').addEventListener('click', onCancelClick);
    }

    function openShop() {
        if (modalEl) return;
        ensureStyles();
        modalEl = document.createElement('div');
        modalEl.id = 'cb-shop-overlay';
        modalEl.className = 'cb-overlay';
        document.body.appendChild(modalEl);
        renderBuyState();
        // Click-outside-to-close
        modalEl.addEventListener('click', function (e) {
            if (e.target === modalEl && !pollTimer) closeModal();
        });
    }

    function onBuyClick(ev) {
        var btn = ev.currentTarget;
        var sku = btn && btn.getAttribute('data-sku');
        var errEl = document.getElementById('cb-error');
        btn.disabled = true;
        errEl.textContent = '';

        fetch('/api/checkout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accountId: getAccountId(), sku: sku })
        })
        .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
        .then(function (resp) {
            if (!resp.ok || !resp.body.redirectUrl || !resp.body.id) {
                throw new Error((resp.body && resp.body.error) || 'Checkout failed');
            }
            currentCheckoutId = resp.body.id;
            // Open Neon in a new tab — game stays put.
            neonTab = window.open(resp.body.redirectUrl, '_blank');
            // Switch modal to waiting state and start polling.
            renderWaitState();
            startPolling();
        })
        .catch(function (err) {
            errEl.textContent = String(err.message || err);
            btn.disabled = false;
        });
    }

    function startPolling() {
        if (!currentCheckoutId) return;
        var POLL_MS = 2000;
        var MAX_MS = 5 * 60 * 1000; // 5 minutes
        pollDeadline = Date.now() + MAX_MS;
        poll();
        pollTimer = setInterval(poll, POLL_MS);
    }

    function poll() {
        if (!currentCheckoutId) return;
        if (Date.now() > pollDeadline) {
            fetch('/api/checkout/' + encodeURIComponent(currentCheckoutId) + '/expire', { 
                method: 'POST' ,
                headers: { 'content-type': 'application/json', 'accept': 'application/json' },
            })
            .then(function () { stopPollingWithMessage('Timed out. Close the payment tab and try again.'); })
            .catch(function () { stopPollingWithMessage('Timed out. Close the payment tab and try again.'); })
            return;
        }
        var statusEl = document.getElementById('cb-status');
        fetch('/api/checkout/' + encodeURIComponent(currentCheckoutId), { 
            method: 'GET' ,
            headers: { 'accept': 'application/json' },
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.status === 'complete') {
                stopPolling();
                refreshEntitlements(function () { closeModal(); });
            } else if (data.status === 'cancelled' || data.status === 'expired') {
                stopPollingWithMessage('Checkout was cancelled.');
            } else if (statusEl) {
                statusEl.textContent = 'Status: ' + data.status + '...';
            }
        })
        .catch(function () { /* network blip; keep polling */ });
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function stopPollingWithMessage(msg) {
        stopPolling();
        var statusEl = document.getElementById('cb-status');
        if (statusEl) statusEl.textContent = msg;
        // Replace Cancel button with Close so the user can dismiss.
        var cancelBtn = document.getElementById('cb-cancel-btn');
        if (cancelBtn) {
            cancelBtn.textContent = 'Close';
            cancelBtn.onclick = closeModal;
        }
    }

    function onCancelClick() {
        if (!currentCheckoutId) { closeModal(); return; }
        fetch('/api/checkout/' + encodeURIComponent(currentCheckoutId) + '/expire', { 
            method: 'POST' ,
            headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        })
        .then(function () { stopPollingWithMessage('Expired(Cancelled).'); })
        .catch(function () { stopPollingWithMessage('Expired(Cancelled).'); });
        console.log('Expired(Cancelled) checkout', currentCheckoutId);
    }

    // Public API.
    window.CBShop = {
        getAccountId: getAccountId,
        openShop: openShop,
        closeShop: closeModal,
        refreshEntitlements: refreshEntitlements,
        loadCachedEntitlements: loadCachedEntitlements,
        totalHearts: totalHearts,
        BASE_HEARTS: BASE_HEARTS,
        MAX_PURCHASES: MAX_PURCHASES
    };

    // Refresh entitlements on page load so the HUD is correct.
    document.addEventListener('DOMContentLoaded', function () {
        refreshEntitlements();
    });
})();