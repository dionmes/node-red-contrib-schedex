/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2019 @biddster
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const { compose } = require('@stamp/it');

const Schedex = compose({
    props: {
        moment: require('moment'),
        SunCalc: require('suncalc'),
        _: require('lodash'),
        fmt: 'YYYY-MM-DD HH:mm',
        Status: Object.freeze({
            SCHEDULED: Symbol('scheduled'),
            SUSPENDED: Symbol('suspended'),
            FIRED: Symbol('fired'),
            ERROR: Symbol('error')
        })
    },
    init({ node, config }) {
        this.node = node;
        this.config = config;
        this.events = {};

        this.node.on('input', this.onInput.bind(this));
        this.node.on('close', this.suspend.bind(this));

        // Bodges to allow testing
        this.node.schedexEvents = () => this.events;
        this.node.schedexConfig = () => this.config;
        this.node.now = this.moment;

        // migration code : if new values are undefined, set all to true
        if (
            config.sun === undefined &&
            config.mon === undefined &&
            config.tue === undefined &&
            config.wed === undefined &&
            config.thu === undefined &&
            config.fri === undefined &&
            config.sat === undefined
        ) {
            const name = config.name || `${config.ontime} - ${config.offtime}`;
            node.warn(
                `Schedex [${name}]: New weekday configuration attributes are not defined, please edit the node. Defaulting to true.`
            );
            config.sun = config.mon = config.tue = config.wed = config.thu = config.fri = config.sat = true;
        }

        this.bootstrap();
        // Assume the node is off initially
        this.lastEvent = this.events.off;
    },
    methods: {
        inverse(event) {
            return event === this.events.on ? this.events.off : this.events.on;
        },
        getWeekdayConfig() {
            return [
                this.config.mon,
                this.config.tue,
                this.config.wed,
                this.config.thu,
                this.config.fri,
                this.config.sat,
                this.config.sun
            ];
        },
        isSuspended() {
            return (
                this.config.suspended ||
                this.getWeekdayConfig().indexOf(true) === -1 ||
                (!this.events.on.time && !this.events.off.time)
            );
        },
        setStatus(status, { event = null, manual = false, error = null } = {}) {
            const message = [];
            let shape = 'dot';
            let fill = 'red';
            if (status === this.Status.SCHEDULED) {
                fill = 'yellow';
                if (this.events.on.moment && this.events.off.moment) {
                    const firstEvent = this.events.on.moment.isBefore(this.events.off.moment)
                        ? this.events.on
                        : this.events.off;
                    message.push(firstEvent.name);
                    message.push(firstEvent.moment.format(this.fmt));
                    message.push(this.inverse(firstEvent).name);
                    message.push(this.inverse(firstEvent).moment.format(this.fmt));
                } else if (this.events.on.moment) {
                    message.push(this.events.on.name);
                    message.push(this.events.on.moment.format(this.fmt));
                } else if (this.events.off.moment) {
                    message.push(this.events.off.name);
                    message.push(this.events.off.moment.format(this.fmt));
                }
            } else if (status === this.Status.FIRED) {
                // eslint-disable-next-line prefer-destructuring
                shape = event.shape;
                fill = manual ? 'blue' : 'green';
                message.push(event.name);
                message.push(manual ? 'manual' : 'auto');
                if (this.isSuspended()) {
                    message.push('- scheduling suspended');
                } else if (this.inverse(event).moment) {
                    message.push(
                        `until ${this.inverse(event).name} at ${this.inverse(
                            event
                        ).moment.format(this.fmt)}`
                    );
                } else {
                    const next = this.inverse(event).moment ? this.inverse(event) : event;
                    if (next.moment) {
                        message.push(`until ${next.name} at ${next.moment.format(this.fmt)}`);
                    }
                }
            } else if (status === this.Status.SUSPENDED) {
                fill = 'grey';
                message.push('Scheduling suspended');
                if (this.getWeekdayConfig().indexOf(true) === -1) {
                    message.push('(no weekdays selected)');
                } else if (!this.events.on.time && !this.events.off.time) {
                    message.push('(no on or off time)');
                }
                message.push('- manual mode only');
            } else if (status === this.Status.ERROR) {
                message.push(error);
            }

            this.node.status({ fill, shape, text: message.join(' ') });
        },
        send(event, manual) {
            this.lastEvent = event;
            this.node.send({ topic: event.topic, payload: event.payload });
            this.setStatus(this.Status.FIRED, { event, manual });
        },
        teardownEvent(event) {
            if (event) {
                if (event.timeout) {
                    clearTimeout(event.timeout);
                }
                event.moment = null;
            }
        },
        schedule(event, isInitial) {
            this.teardownEvent(event);

            if (!event.time) {
                return true;
            }

            const now = this.node.now();
            const matches = new RegExp('(\\d+):(\\d+)', 'u').exec(event.time);
            if (matches && matches.length) {
                // Don't use existing 'now' moment here as hour and minute mutate the moment.
                event.moment = this.node
                    .now()
                    .hour(+matches[1])
                    .minute(+matches[2]);
            } else {
                const sunCalcTimes = this.SunCalc.getTimes(
                    new Date(),
                    this.config.lat,
                    this.config.lon
                );
                const date = sunCalcTimes[event.time];
                if (date) {
                    event.moment = this.moment(date);
                }
            }
            if (!event.moment) {
                this.setStatus(this.Status.ERROR, { error: `Invalid time [${event.time}]` });
                return false;
            }
            event.moment.seconds(0);

            if (event.offset) {
                let adjustment = event.offset;
                if (event.randomoffset) {
                    adjustment = event.offset * Math.random();
                }
                event.moment.add(adjustment, 'minutes');
            }

            if (!isInitial || (isInitial && now.isAfter(event.moment))) {
                event.moment.add(1, 'day');
            }

            // Adjust weekday if not selected
            const weekdays = this.getWeekdayConfig();
            while (!weekdays[event.moment.isoWeekday() - 1]) {
                event.moment.add(1, 'day');
            }
            const delay = event.moment.diff(now);
            event.timeout = setTimeout(event.callback, delay);
            return true;
        },
        setupEvent(eventName, shape) {
            const filtered = this._.pickBy(this.config, function(value, key) {
                return key && key.indexOf(eventName) === 0;
            });
            const event = this._.mapKeys(filtered, function(value, key) {
                return key.substring(eventName.length).toLowerCase();
            });
            event.name = eventName.toUpperCase();
            event.shape = shape;
            event.callback = () => {
                this.send(event);
                this.schedule(event);
            };
            return event;
        },
        suspend() {
            this.teardownEvent(this.events.on);
            this.teardownEvent(this.events.off);
            this.setStatus(this.Status.SUSPENDED);
        },
        resume() {
            if (this.schedule(this.events.on, true) && this.schedule(this.events.off, true)) {
                this.setStatus(this.Status.SCHEDULED);
            }
        },
        bootstrap() {
            this.teardownEvent(this.events.on);
            this.teardownEvent(this.events.off);
            this.events.on = this.setupEvent('on', 'dot');
            this.events.off = this.setupEvent('off', 'ring');
            if (this.isSuspended()) {
                this.suspend();
            } else {
                this.resume();
            }
        },
        toBoolean(val) {
            // eslint-disable-next-line prefer-template
            return (val + '').toLowerCase() === 'true';
        },
        enumerateProgrammables(callback) {
            callback(this.config, 'ontime', String);
            callback(this.config, 'ontopic', String);
            callback(this.config, 'onpayload', String);
            callback(this.config, 'onoffset', Number);
            callback(this.config, 'onrandomoffset', this.toBoolean);
            callback(this.config, 'offtime', String);
            callback(this.config, 'offtopic', String);
            callback(this.config, 'offpayload', String);
            callback(this.config, 'offoffset', Number);
            callback(this.config, 'offrandomoffset', this.toBoolean);
            callback(this.config, 'mon', this.toBoolean);
            callback(this.config, 'tue', this.toBoolean);
            callback(this.config, 'wed', this.toBoolean);
            callback(this.config, 'thu', this.toBoolean);
            callback(this.config, 'fri', this.toBoolean);
            callback(this.config, 'sat', this.toBoolean);
            callback(this.config, 'sun', this.toBoolean);
            callback(this.config, 'lon', Number);
            callback(this.config, 'lat', Number);
            callback(this.config, 'suspended', this.toBoolean);
        },
        onInput(msg) {
            let requiresBootstrap = false;
            let handled = false;
            if (this._.isString(msg.payload)) {
                // TODO - with these payload options, we can't support on and ontime etc.
                if (msg.payload === 'on') {
                    handled = true;
                    this.send(this.events.on, true);
                } else if (msg.payload === 'off') {
                    handled = true;
                    this.send(this.events.off, true);
                } else if (msg.payload === 'toggle') {
                    handled = true;
                    this.send(this.inverse(this.lastEvent), true);
                } else if (msg.payload === 'info') {
                    handled = true;
                    const payload = this._.clone(this.config);
                    payload.on = this.isSuspended()
                        ? 'suspended'
                        : this.events.on.moment.toDate().toUTCString();
                    payload.off = this.isSuspended()
                        ? 'suspended'
                        : this.events.off.moment.toDate().toUTCString();
                    // eslint-disable-next-line no-nested-ternary
                    payload.state = this.isSuspended()
                        ? 'suspended'
                        : this.events.off.moment.isAfter(this.events.on.moment)
                        ? 'off'
                        : 'on';
                    this.node.send({ topic: 'info', payload });
                } else {
                    this.enumerateProgrammables(function(cfg, prop, typeConverter) {
                        const match = new RegExp(`.*${prop}\\s+(\\S+)`, 'u').exec(msg.payload);
                        if (match) {
                            handled = true;
                            const previous = cfg[prop];
                            cfg[prop] = typeConverter(match[1]);
                            requiresBootstrap = requiresBootstrap || previous !== cfg[prop];
                        }
                    });
                }
            } else {
                this.enumerateProgrammables(function(cfg, prop, typeConverter) {
                    if (Object.prototype.hasOwnProperty.call(msg.payload, prop)) {
                        handled = true;
                        const previous = cfg[prop];
                        cfg[prop] = typeConverter(msg.payload[prop]);
                        requiresBootstrap = requiresBootstrap || previous !== cfg[prop];
                    }
                });
            }
            if (!handled) {
                this.setStatus(this.Status.ERROR, { error: 'Unsupported input' });
            } else if (requiresBootstrap) {
                this.bootstrap();
            }
        }
    }
});

module.exports = Schedex;
