'''
Created on 1 juil. 2013

@author: Aristote Diasonama
'''

import datetime as datetime_module

ZERO = datetime_module.timedelta(0)
HOUR = datetime_module.timedelta(hours=1)

class UTC(datetime_module.tzinfo):
    """UTC"""

    def utcoffset(self, dt):
        return ZERO

    def tzname(self, dt):
        return "UTC"

    def dst(self, dt):
        return ZERO
    
class Eastern_tzinfo(datetime_module.tzinfo):
    """Implementation of the Pacific timezone."""
    def utcoffset(self, dt):
        return datetime_module.timedelta(hours=-5) + self.dst(dt)

    def _FirstSunday(self, dt):
        """First Sunday on or after dt."""
        return dt + datetime_module.timedelta(days=(6-dt.weekday()))

    def dst(self, dt):
        # 2 am on the second Sunday in March
        dst_start = self._FirstSunday(datetime_module.datetime(dt.year, 3, 8, 2))
        # 1 am on the first Sunday in November
        dst_end = self._FirstSunday(datetime_module.datetime(dt.year, 11, 1, 1))

        if dst_start <= dt.replace(tzinfo=None) < dst_end:
            return datetime_module.timedelta(hours=1)
        else:
            return datetime_module.timedelta(hours=0)
    def tzname(self, dt):
        if self.dst(dt) == datetime_module.timedelta(hours=0):
            return "EST"
        else:
            return "EDT"

