 /**
 * @author Thefuture2092
 *
 */

 "use strict";

define(function(){

	function Slot(slot_data) {
		this.populate(slot_data);
	};

	Slot.prototype = {
		constructor : Slot,
		populate : function(slot_data) {
			this.id = slot_data.slot_id;
			this.offset = slot_data.offset;
			this.duration = slot_data.duration;
			this.executed = slot_data.executed;
			this.task_id = slot_data.task_id;
			this.links = slot_data.links;
		}
	};

	return Slot;
})