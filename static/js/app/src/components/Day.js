/** @jsx React.DOM */
 /**
 * @author Thefuture2092
 *
 */

"use strict";

define(["react", "components/Slot"], function(React, SlotComponent){

	var ReactPropTypes = React.PropTypes;

	var DayComponent = React.createClass({

		propTypes : {
			day : ReactPropTypes.object.isRequired
	    },
		getInitialState : function() {

		},

		componentDidMount: function() {

		},

		componentWillUnmount: function() {

		},

		render: function() {

			var day = this.props.day;
			var slots = [];
			keys = [];
			for (key in day.slots){
				keys.push(key);
			}
			keys.sort(function(a,b) { return a-b});

			for (key in keys) {
				slots.push(<SlotComponent key = {key} slot = {day.slots[slot]}/>)
			}

			return (
				
			 	<div className="panel panel-default">
    				<div className="panel-heading" role="tab" id="headingOne">
      					<h4 className="panel-title">
        					<a data-toggle="collapse" data-parent="#accordion" href="#collapseOne" aria-expanded="true" aria-controls="collapseOne">
          						Monday 3 september | Task : 18 | Completed : 5
        					</a>
      					</h4>
    				</div>
    				<div id="collapseOne" className="panel-collapse collapse in" role="tabpanel" aria-labelledby="headingOne">
      					<div className="panel-body">
        					{slots}
                        </div>
                    </div>
  				</div>
			);
		}
	});

	return DayComponent;
})