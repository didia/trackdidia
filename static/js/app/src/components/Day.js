/** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["exports", "react", "components/Slot", "components/EmptySlot", "app/utils", "bootstrap"], function(exports, React, SlotComponent, EmptySlot, Utils){

	var ReactPropTypes = React.PropTypes;

	var DayComponent = React.createClass({

		propTypes : {
			day : ReactPropTypes.object.isRequired
	    },
		getInitialState : function() {
			return null;
		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		createEmptySlot: function(offset, duration) {
			var startAndFinish = this.props.day.getStartAndFinishHour(offset, duration);
			var start = Utils.convertToHourString(startAndFinish[0]);
			var finish = Utils.convertToHourString(startAndFinish[1]);
			return <EmptySlot day = {this.props.day} key = {offset} start = {start} finish = {finish} offset = {offset} duration = {duration} />;
		},
		
		createSlot: function(slot) {
			var startAndFinish = this.props.day.getStartAndFinishHour(slot.offset, slot.duration);
			var start = Utils.convertToHourString(startAndFinish[0]);
			var finish = Utils.convertToHourString(startAndFinish[1]);
			return <SlotComponent day = {this.props.day} start = {start} finish = {finish} key = {slot.offset} slot = {slot}/>
		},

		render: function() {

			var day = this.props.day;
			var day_id = day.id;
			var slots = [];
			var keys = [];
			var lastKey = -1;
			
			for (var key in day.slots){
				keys.push(key);
			}

			keys.sort(function(a,b) { return a-b});
			var that = this;
			keys.forEach(function(key){
				if(key - lastKey != 1) {
					var offset = lastKey + 1;
					var duration = key - offset;
					slots.push(that.createEmptySlot(offset, duration));
				}
				
				slots.push(that.createSlot(day.slots[key]));
				//last occupied key is offset + duration -1 because we don't count last end of interval is exclusive.
				lastKey = day.slots[key].offset + day.slots[key].duration - 1; 
		
			});
			if(lastKey != this.props.day.usage.length) {
				var offset = lastKey + 1;
				var duration = day.usage.length - offset;
				slots.push(this.createEmptySlot(offset, duration));
			}
			var heading_id = "heading-" + day_id;
			var body_id = "collapse-" + day_id;
			var today_code = Utils.getTodayCode();
			var expanded = today_code == day_id;
			var dayName = Utils.getDayString(day_id);
			var numberOfTask = keys.length;
			var numberOfCompletedTask = day.getNumberOfCompletedTask();
	

			return (
				
			 	<div className="panel panel-default">
    				<div className="panel-heading" role="tab" id={heading_id}>
      					<h4 className="panel-title">
        					<a data-toggle="collapse" data-parent="#schedule" href={"#" + body_id } aria-expanded={expanded? "true": "false"} aria-controls={body_id}>
          						<span> {dayName} </span> | Task : {numberOfTask} | Completed : {numberOfCompletedTask}
        					</a>
      					</h4>
    				</div>
    				<div id={body_id} className={expanded? "panel-collapse collapse in":"panel-collapse collapse"} role="tabpanel" aria-labelledby={heading_id}>
      					<div className="panel-body">
        					{slots}
                        </div>
                    </div>
  				</div>
			);
		}
	});

	return exports.DayComponent = DayComponent;
})