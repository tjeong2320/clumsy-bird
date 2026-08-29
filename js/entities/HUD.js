game.HUD = game.HUD || {};

game.HUD.Container = me.Container.extend({
    init: function() {
        this._super(me.Container, 'init');
        // persistent across level change
        this.isPersistent = true;

        // non collidable
        this.collidable = false;

        // make sure our object is always draw first
        this.z = Infinity;

        // give a name
        this.name = "HUD";

        // add our child score object at the top left corner
        this.addChild(new game.HUD.ScoreItem(5, 5));
        // top-right heart row
        this.addChild(new game.HUD.HeartItem());
    }
});


game.HUD.ScoreItem = me.Renderable.extend({
    init: function(x, y) {
        this._super(me.Renderable, "init", [x, y, 10, 10]);

        // local copy of the global score
        this.stepsFont = new me.Font('gamefont', 80, '#000', 'center');

        // make sure we use screen coordinates
        this.floating = true;
    },

    draw: function (renderer) {
        if (game.data.start && me.state.isCurrent(me.state.PLAY))
            this.stepsFont.draw(renderer, game.data.steps, me.game.viewport.width/2, 10);
    }

});


/**
 * Top-right row of heart sprites showing the player's current lives.
 * The displayed count is min(currentLives, maxHearts), where:
 *   - maxHearts comes from window.CBShop.loadCachedEntitlements() and is
 *     refreshed when 'cb:entitlements' fires (after a successful purchase).
 *   - currentLives is decremented on each hit via the 'cb:lives' event
 *     dispatched from BirdEntity.onCollision, and reset to maxHearts on
 *     each new run via 'cb:entitlements' / play state entry.
 */
game.HUD.HeartItem = me.Renderable.extend({
    init: function() {
        // x/y are placeholders; we render relative to viewport.width.
        this._super(me.Renderable, "init", [0, 0, 10, 10]);
        this.floating = true;
        this.heartImg = null; // resolved lazily
        this.lastHearts = -1; // force initial draw
        // Seed from localStorage so the first paint is correct even before
        // the server round-trip completes.
        this.maxHearts = this._totalHearts();
        this.currentLives = this.maxHearts;
        this._cbEntHandler = null;
        this._cbLivesHandler = null;
    },

    onActivateEvent: function() {
        var self = this;
        // Update the cap (not currentLives) when entitlements change. Lives
        // are owned by the Bird entity; the HUD shouldn't reset them mid-run.
        this._cbEntHandler = function () {
            self.maxHearts = self._totalHearts();
            self.lastHearts = -1;
        }.bind(this);
        // Decrement on each hit while playing.
        this._cbLivesHandler = function (e) {
            if (!e || !e.detail) return;
            if (typeof e.detail.maxHearts === 'number') {
                self.maxHearts = e.detail.maxHearts;
            }
            if (typeof e.detail.currentLives === 'number') {
                self.currentLives = e.detail.currentLives;
            }
            self.lastHearts = -1;
        }.bind(this);
        window.addEventListener('cb:entitlements', this._cbEntHandler);
        window.addEventListener('cb:lives', this._cbLivesHandler);
    },

    onDeactivateEvent: function() {
        if (this._cbEntHandler) window.removeEventListener('cb:entitlements', this._cbEntHandler);
        if (this._cbLivesHandler) window.removeEventListener('cb:lives', this._cbLivesHandler);
        this._cbEntHandler = null;
        this._cbLivesHandler = null;
    },

    _ensureImage: function() {
        if (this.heartImg) return;
        try { this.heartImg = me.loader.getImage('heart'); } catch (e) {}
    },

    _totalHearts: function() {
        var ent = (window.CBShop && window.CBShop.loadCachedEntitlements())
                  || { heartsPurchased: 0 };
        var base = (window.CBShop && window.CBShop.BASE_HEARTS) || 1;
        var maxP = (window.CBShop && window.CBShop.MAX_PURCHASES) || 4;
        return Math.min(base + (ent.heartsPurchased || 0), base + maxP);
    },

    draw: function(renderer) {
        if (!me.state.isCurrent(me.state.PLAY)) return;
        if (!game.data.start) return;

        this._ensureImage();

        // Display = how many hearts the bird has left, capped by max.
        var display = Math.max(0, Math.min(this.currentLives, this.maxHearts));
        // if (display === this.lastHearts && this.lastHearts !== 1 && this.heartImg) {
        //     return;
        // }
        this.lastHearts = display;

        var size = 80;
        var pad = 30;
        var startX = me.game.viewport.width - (size - pad) * display - 15;
        var y = 10;

        if (this.heartImg && this.heartImg.width) {
            for (var i = 0; i < display; i++) {
                renderer.drawImage(
                    this.heartImg,
                    startX + i * (size - pad),
                    y,
                    size,
                    size
                );
            }
        } else {
            // Fallback: text rendering if image isn't loaded yet.
            var font = new me.Font('gamefont', 24, '#c33', 'right');
            font.draw(renderer, 'x' + display, me.game.viewport.width - 10, 10);
        }
    }
});

var BackgroundLayer = me.ImageLayer.extend({
    init: function(image, z, speed) {
        var settings = {};
        settings.name = image;
        settings.width = 900;
        settings.height = 600;
        settings.image = image;
        settings.z = z;
        settings.ratio = 1;
        // call parent constructor
        this._super(me.ImageLayer, 'init', [0, 0, settings]);
    },

    update: function() {
        if (me.input.isKeyPressed('mute')) {
            game.data.muted = !game.data.muted;
            if (game.data.muted){
                me.audio.disable();
            }else{
                me.audio.enable();
            }
        }
        return true;
    }
});
