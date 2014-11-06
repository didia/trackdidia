 /**
 * @author Thefuture2092
 *
 */

define(function(){

	function Slot(slot_data) {
		this.id = slot_data.slot_id;
		this.offset = slot_data.offset;
		this.duration = slot_data.duration;
		this.executed = slot_data.executed;
		this.task_id = slot_data.task_id;
	};

	return Slot;
})